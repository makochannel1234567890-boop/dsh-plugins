/**
 * lib/emulator.js の単体テスト。
 * すべて opts.run をモックして実行する（実エミュレーター・ネットワーク不要）。
 *
 * 実行: cd dsh-emulator-lab && node --test test/emulator.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  detectEmulators,
  buildAvdArgs,
  clampConstraints,
  buildBootArgs,
  buildSimctlArgs,
  launch,
  sampleFps,
  shutdown,
} from '../lib/emulator.js';

/* ------------------------------------------------------------------ */
/* フィクスチャ                                                        */
/* ------------------------------------------------------------------ */

const UDID = '0A1B2C3D-1111-2222-3333-444455556666';

const AVD_LIST_FIXTURE = `Available Android Virtual Devices:
    Name: Pixel_2_API_30
    Path: C:\\Users\\test\\.android\\avd\\Pixel_2_API_30.avd
  Target: android-30 (API 30)
          Based on: Google APIs Intel x86 Atom System Image
        Tag/ABI: google_apis/x86_64
    Skin: pixel_2
  Sdcard: 512M
---------
    Name: LowEnd_AVD
    Path: C:\\Users\\test\\.android\\avd\\LowEnd_AVD.avd
  Target: android-29 (API 29)
        Tag/ABI: default/x86
`;

const SIMCTL_RUNTIMES_FIXTURE = `== Runtimes ==
iOS 17.5 (17.5 - 21F79) - com.apple.CoreSimulator.SimRuntime.iOS-17-5 (available)
iOS 16.4 (16.4 - 20E247) - com.apple.CoreSimulator.SimRuntime.iOS-16-4 (unavailable)
`;

const SIMCTL_DEVICES_FIXTURE = `== Devices ==
-- iOS 17.5 --
    iPhone SE (3rd generation) (0A1B2C3D-1111-2222-3333-444455556666) (Shutdown)
    iPhone 15 (AAAAAAAA-BBBB-CCCC-DDDD-EEEEFFFF0000) (Booted)
-- iOS 16.4 --
    iPhone SE (3rd generation) (11111111-2222-3333-4444-555566667777) (Shutdown)
`;

const GFXINFO_FIXTURE = `Applications Graphics Acceleration Info:
Uptime: 123456 Realtime: 654321

** Graphics info for pid 4242 [com.example.game] **

Stats since: 12345678901234ns
Total frames rendered: 4
Janky frames: 1 (25.00%)
---PROFILEDATA---
Flags,IntendedVsync,Vsync,OldestInputEvent,NewestInputEvent,HandleInputStart,AnimationStart,PerformTraversalsStart,DrawStart,SyncQueued,SyncStart,IssueDrawCommandsStart,SwapBuffers,FrameCompleted,DequeueBufferDuration,QueueBufferDuration,GpuCompleted,SwapBuffersCompleted,DisplayPresentTime,CommandSubmissionCompleted
0,1000000000,1000000000,0,9223372036854775807,1000000100,1000000200,1000000300,1000000400,1000000500,1000000600,1000000700,1000010000,1000000000,50000,60000,1000009000,1000010000,1000011000,1000012000
0,1020000000,1020000000,0,9223372036854775807,1020000100,1020000200,1020000300,1020000400,1020000500,1020000600,1020000700,1020010000,1020000000,50000,60000,1020009000,1020010000,1020011000,1020012000
0,1040000000,1040000000,0,9223372036854775807,1040000100,1040000200,1040000300,1040000400,1040000500,1040000600,1040000700,1040010000,1040000000,50000,60000,1040009000,1040010000,1040011000,1040012000
0,1060000000,1060000000,0,9223372036854775807,1060000100,1060000200,1060000300,1060000400,1060000500,1060000600,1060000700,1060010000,1060000000,50000,60000,1060009000,1060010000,1060011000,1060012000
---PROFILEDATA---
`;

/* ------------------------------------------------------------------ */
/* ハーネス                                                            */
/* ------------------------------------------------------------------ */

/**
 * route = { match:function|string, value:object|function }
 * value に { __throw:true, message } を入れると run が reject する。
 */
function fakeRun(routes, calls = []) {
  const run = async (cmd, args = [], runOpts = {}) => {
    const call = { cmd, args: [...args], runOpts };
    calls.push(call);
    const joined = [cmd, ...args].join(' ');

    for (const route of routes) {
      const matched = typeof route.match === 'function'
        ? route.match({ cmd, args, joined, runOpts })
        : joined.startsWith(route.match);
      if (!matched) continue;

      const value = typeof route.value === 'function'
        ? route.value({ cmd, args, joined, runOpts })
        : route.value;
      if (value && value.__throw) throw new Error(value.message ?? 'boom');
      return { code: 0, stdout: '', stderr: '', pid: null, error: null, ...value };
    }

    return { code: 1, stdout: '', stderr: `unknown command: ${joined}`, pid: null, error: 'unknown command' };
  };
  run.calls = calls;
  return run;
}

function routeCmd(cmd, argPrefix = [], value = {}) {
  return {
    match: ({ cmd: actualCmd, args }) =>
      actualCmd === cmd && argPrefix.every((expected, i) => args[i] === expected),
    value,
  };
}

function androidDetectedRun(calls = []) {
  return fakeRun(
    [
      routeCmd('emulator.exe', ['-version'], { code: 0, stdout: 'Android emulator version 34.1.9' }),
      routeCmd('adb.exe', ['version'], { code: 0, stdout: 'Android Debug Bridge version 1.0.41' }),
      routeCmd('avdmanager.bat', ['list', 'avd'], { code: 0, stdout: AVD_LIST_FIXTURE }),
    ],
    calls,
  );
}

/* ------------------------------------------------------------------ */
/* detectEmulators                                                     */
/* ------------------------------------------------------------------ */

test('detectEmulators: Windows では iOS 側が必ず available:false（ツールがあっても）', async () => {
  const run = fakeRun([
    routeCmd('xcrun', ['--version'], { code: 0, stdout: 'xcrun version 66' }),
    routeCmd('xcrun', ['simctl', 'help'], { code: 0, stdout: 'simctl help' }),
  ]);

  const detected = await detectEmulators({ platform: 'win32', env: {}, run });

  assert.deepEqual(detected.ios, {
    available: false,
    xcrunPath: null,
    simctlPath: null,
    runtimes: [],
    devices: [],
  });
  assert.equal(detected.android.available, false);
});

test('detectEmulators: Android ツールが無ければ available:false（例外なし）', async () => {
  const run = fakeRun([]);
  const detected = await detectEmulators({ platform: 'win32', env: {}, run });

  assert.deepEqual(detected.android, {
    available: false,
    emulatorPath: null,
    avdmanagerPath: null,
    adbPath: null,
    avds: [],
  });
});

test('detectEmulators: adb が無いと android.available は false（emulator だけでは不可）', async () => {
  const run = fakeRun([routeCmd('emulator.exe', ['-version'], { code: 0, stdout: 'ok' })]);
  const detected = await detectEmulators({ platform: 'win32', env: {}, run });

  assert.equal(detected.android.available, false);
  assert.equal(detected.android.emulatorPath, 'emulator.exe');
  assert.equal(detected.android.adbPath, null);
});

test('detectEmulators: Windows で AVD 一覧をパースする', async () => {
  const run = androidDetectedRun();
  const detected = await detectEmulators({ platform: 'win32', env: {}, run });

  assert.equal(detected.android.available, true);
  assert.equal(detected.android.emulatorPath, 'emulator.exe');
  assert.equal(detected.android.adbPath, 'adb.exe');
  assert.equal(detected.android.avdmanagerPath, 'avdmanager.bat');
  assert.equal(detected.android.avds.length, 2);
  assert.deepEqual(detected.android.avds[0], {
    name: 'Pixel_2_API_30',
    target: 'android-30 (API 30)',
    apiLevel: 30,
    ramMb: null,
  });
  assert.equal(detected.android.avds[1].apiLevel, 29);
});

test('detectEmulators: avdmanager が無い場合は emulator -list-avds にフォールバック', async () => {
  const run = fakeRun([
    routeCmd('emulator.exe', ['-version'], { code: 0, stdout: 'ok' }),
    routeCmd('adb.exe', ['version'], { code: 0, stdout: 'ok' }),
    routeCmd('emulator.exe', ['-list-avds'], { code: 0, stdout: 'Pixel_2_API_30\nLowEnd_AVD\n' }),
  ]);
  const detected = await detectEmulators({ platform: 'win32', env: {}, run });

  assert.equal(detected.android.available, true);
  assert.equal(detected.android.avdmanagerPath, null);
  assert.deepEqual(detected.android.avds.map((avd) => avd.name), ['Pixel_2_API_30', 'LowEnd_AVD']);
});

test('detectEmulators: macOS で runtimes / devices をパースする', async () => {
  const run = fakeRun([
    routeCmd('xcrun', ['--version'], { code: 0, stdout: 'xcrun version 66' }),
    routeCmd('xcrun', ['simctl', 'help'], { code: 0, stdout: 'simctl help' }),
    routeCmd('xcrun', ['simctl', 'list', 'runtimes'], { code: 0, stdout: SIMCTL_RUNTIMES_FIXTURE }),
    routeCmd('xcrun', ['simctl', 'list', 'devices'], { code: 0, stdout: SIMCTL_DEVICES_FIXTURE }),
  ]);
  const detected = await detectEmulators({ platform: 'darwin', env: {}, run });

  assert.equal(detected.ios.available, true);
  assert.equal(detected.ios.xcrunPath, 'xcrun');
  assert.equal(detected.ios.simctlPath, 'xcrun');
  assert.deepEqual(detected.ios.runtimes, ['iOS 17.5', 'iOS 16.4']);
  assert.equal(detected.ios.devices.length, 3);
  assert.deepEqual(detected.ios.devices[0], {
    name: 'iPhone SE (3rd generation)',
    udid: UDID,
    state: 'Shutdown',
    runtime: 'iOS 17.5',
  });
  assert.equal(detected.ios.devices[1].state, 'Booted');
});

test('detectEmulators: ANDROID_HOME 配下の emulator/adb/avdmanager.bat を解決する', async () => {
  const sdk = 'C:\\sdk';
  const run = fakeRun([
    routeCmd(`${sdk}\\emulator\\emulator.exe`, ['-version'], { code: 0, stdout: 'ok' }),
    routeCmd(`${sdk}\\platform-tools\\adb.exe`, ['version'], { code: 0, stdout: 'ok' }),
    routeCmd(`${sdk}\\cmdline-tools\\latest\\bin\\avdmanager.bat`, ['list', 'avd'], {
      code: 0,
      stdout: AVD_LIST_FIXTURE,
    }),
  ]);
  const detected = await detectEmulators({ platform: 'win32', env: { ANDROID_HOME: sdk }, run });

  assert.equal(detected.android.available, true);
  assert.equal(detected.android.emulatorPath, `${sdk}\\emulator\\emulator.exe`);
  assert.equal(detected.android.adbPath, `${sdk}\\platform-tools\\adb.exe`);
  assert.equal(detected.android.avdmanagerPath, `${sdk}\\cmdline-tools\\latest\\bin\\avdmanager.bat`);
  assert.equal(detected.android.avds.length, 2);
});

test('detectEmulators: run が reject しても例外を投げず available:false', async () => {
  const run = async () => {
    throw new Error('spawn ENOENT');
  };
  const detected = await detectEmulators({ platform: 'win32', env: {}, run });

  assert.equal(detected.android.available, false);
  assert.equal(detected.ios.available, false);
});

/* ------------------------------------------------------------------ */
/* buildAvdArgs / clampConstraints                                     */
/* ------------------------------------------------------------------ */

test('buildAvdArgs: RAM とヒープが引数に反映される', () => {
  const args = buildAvdArgs(
    { name: 'LowEnd_AVD', apiLevel: 30, device: 'pixel_2' },
    { ramMb: 2048, heapMb: 192 },
  );

  assert.equal(args.at(-1), '--force');
  assert.equal(args[args.indexOf('-n') + 1], 'LowEnd_AVD');
  assert.equal(args[args.indexOf('-k') + 1], 'system-images;android-30;google_apis;x86_64');
  assert.equal(args[args.indexOf('-d') + 1], 'pixel_2');
  assert.equal(args[args.indexOf('-c') + 1], '2048M');
  assert.equal(args[args.indexOf('-H') + 1], '192M');
});

test('buildAvdArgs: avdPath 指定時は -p を付ける', () => {
  const args = buildAvdArgs(
    { name: 'A', avdPath: 'C:\\avd\\A.avd', systemImage: 'system-images;android-29;default;x86' },
    {},
  );

  assert.equal(args[0], 'create');
  assert.equal(args[1], 'avd');
  assert.equal(args[args.indexOf('-p') + 1], 'C:\\avd\\A.avd');
  // constraints 省略時の既定 RAM は 2048M
  assert.equal(args[args.indexOf('-c') + 1], '2048M');
});

test('clampConstraints: SoC メモリ上限で RAM をクランプし warnings を返す', () => {
  const { constraints, warnings } = clampConstraints(
    {},
    { memoryLimitGB: 3 },
    { ramMb: 8192, heapMb: 256 },
  );

  assert.equal(constraints.ramMb, 3072);
  assert.ok(warnings.some((warning) => warning.startsWith('ram_clamped')));
});

test('clampConstraints: recommendedHeapMb でヒープをクランプし warnings を返す', () => {
  const { constraints, warnings } = clampConstraints(
    {},
    { memoryLimitGB: 8, recommendedHeapMb: 192 },
    { ramMb: 2048, heapMb: 512 },
  );

  assert.equal(constraints.heapMb, 192);
  assert.equal(constraints.ramMb, 2048);
  assert.ok(warnings.some((warning) => warning.startsWith('heap_clamped')));
});

test('clampConstraints: 入力オブジェクトを破壊せず、既定値と正規化を返す', () => {
  const input = { ramMb: 1024, heapMb: 128, cores: 6, gpuMode: 'vulkan', resolution: '720x1600', dpi: 320 };
  const snapshot = { ...input };
  const { constraints, warnings } = clampConstraints({ maxCores: 2 }, {}, input);

  assert.deepEqual(input, snapshot);
  assert.equal(constraints.cores, 2);
  assert.equal(constraints.gpuMode, 'swiftshader_indirect');
  assert.ok(warnings.some((warning) => warning.startsWith('cores_clamped')));
  assert.ok(warnings.some((warning) => warning.startsWith('gpu_mode_normalized')));
});

test('clampConstraints: SoC 情報が無ければクランプしない', () => {
  const { constraints, warnings } = clampConstraints({}, {}, { ramMb: 4096, heapMb: 256 });

  assert.equal(constraints.ramMb, 4096);
  assert.equal(constraints.heapMb, 256);
  assert.deepEqual(warnings, []);
});

test('clampConstraints: 端末プロファイルの resolution {w,h} を取り込む', () => {
  const { constraints } = clampConstraints({ resolution: { w: 1080, h: 2400 } }, { memoryLimitGB: 4 }, {});

  assert.equal(constraints.resolution, '1080x2400');
});

test('buildBootArgs: 端末プロファイルの resolution を -skin に使う', () => {
  const args = buildBootArgs({ name: 'A', resolution: { w: 1080, h: 2400 } }, {});

  assert.equal(args[args.indexOf('-skin') + 1], '1080x2400');
});

/* ------------------------------------------------------------------ */
/* buildBootArgs / buildSimctlArgs                                     */
/* ------------------------------------------------------------------ */

test('buildBootArgs: AVD 名・スナップショット無効・RAM・GPU を渡す', () => {
  const args = buildBootArgs(
    { name: 'LowEnd_AVD' },
    {
      constraints: {
        ramMb: 1536,
        heapMb: 192,
        cores: 2,
        gpuMode: 'swiftshader_indirect',
        resolution: '720x1600',
        dpi: 320,
      },
    },
  );

  assert.equal(args[args.indexOf('-avd') + 1], 'LowEnd_AVD');
  assert.ok(args.includes('-no-snapshot'));
  assert.equal(args[args.indexOf('-memory') + 1], '1536');
  assert.equal(args[args.indexOf('-gpu') + 1], 'swiftshader_indirect');
  assert.equal(args[args.indexOf('-cores') + 1], '2');
  assert.equal(args[args.indexOf('-skin') + 1], '720x1600');
});

test('buildBootArgs: 低速回線（netdelay/netspeed）を再現できる', () => {
  const slow = buildBootArgs({ name: 'A' }, { network: { delay: 'gprs', speed: 'edge' } });
  assert.equal(slow[slow.indexOf('-netdelay') + 1], 'gprs');
  assert.equal(slow[slow.indexOf('-netspeed') + 1], 'edge');

  const none = buildBootArgs({ name: 'A' }, { network: 'none' });
  assert.equal(none[none.indexOf('-netdelay') + 1], 'none');
  assert.equal(none[none.indexOf('-netspeed') + 1], 'full');

  const off = buildBootArgs({ name: 'A' }, {});
  assert.equal(off.includes('-netdelay'), false);
  assert.equal(off.includes('-netspeed'), false);
});

test('buildBootArgs: headless / read-only / 追加引数', () => {
  const args = buildBootArgs(
    { name: 'A' },
    { headless: true, readOnly: true, extraArgs: ['-no-audio'] },
  );

  assert.ok(args.includes('-no-window'));
  assert.ok(args.includes('-read-only'));
  assert.ok(args.includes('-no-audio'));
});

test('buildSimctlArgs: simctl boot と udid を組み立てる', () => {
  const args = buildSimctlArgs({ platform: 'ios', udid: UDID });

  assert.deepEqual(args, ['simctl', 'boot', UDID]);
});

/* ------------------------------------------------------------------ */
/* launch                                                              */
/* ------------------------------------------------------------------ */

test('launch: Android は detached で run を呼び pid と serial を返す', async () => {
  const calls = [];
  const run = fakeRun([routeCmd('emulator.exe', [], { code: 0, pid: 4242 })], calls);

  const handle = await launch(
    { kind: 'android', profile: { name: 'LowEnd_AVD' }, constraints: { ramMb: 2048, heapMb: 192 } },
    { run, emulatorPath: 'emulator.exe', port: 5554 },
  );

  assert.equal(handle.ok, true);
  assert.equal(handle.pid, 4242);
  assert.equal(handle.kind, 'android');
  assert.equal(handle.serial, 'emulator-5554');
  assert.equal(handle.command[0], 'emulator.exe');
  assert.deepEqual(handle.command.slice(1, 3), ['-avd', 'LowEnd_AVD']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].runOpts.detached, true);
});

test('launch: Android 起動失敗は例外ではなくエラー情報で返す', async () => {
  const run = fakeRun([routeCmd('emulator.exe', [], { code: 1, stderr: 'AVD not found', pid: null })]);

  const handle = await launch(
    { kind: 'android', profile: { name: 'Missing_AVD' } },
    { run, emulatorPath: 'emulator.exe' },
  );

  assert.equal(handle.ok, false);
  assert.equal(handle.pid, null);
  assert.equal(handle.serial, 'emulator-5554');
  assert.equal(typeof handle.error.message, 'string');
  assert.equal(handle.error.stderr, 'AVD not found');
});

test('launch: run が throw しても launch は例外を投げない', async () => {
  const run = fakeRun([routeCmd('emulator.exe', [], { __throw: true, message: 'spawn ENOENT' })]);

  const handle = await launch({ kind: 'android', profile: { name: 'A' } }, { run, emulatorPath: 'emulator.exe' });

  assert.equal(handle.ok, false);
  assert.equal(handle.error.message, 'spawn ENOENT');
});

test('launch: iOS は simctl boot の後に status_bar override を打つ', async () => {
  const calls = [];
  const run = fakeRun(
    [
      routeCmd('xcrun', ['simctl', 'boot'], { code: 0 }),
      routeCmd('xcrun', ['simctl', 'status_bar'], { code: 0 }),
    ],
    calls,
  );

  const handle = await launch(
    {
      kind: 'ios',
      profile: {
        platform: 'ios',
        udid: UDID,
        simulator: { statusBar: { time: '09:41', batteryLevel: 20 } },
      },
    },
    { run },
  );

  assert.equal(handle.ok, true);
  assert.equal(handle.kind, 'ios');
  assert.equal(handle.pid, null);
  assert.equal(handle.serial, UDID);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args, ['simctl', 'boot', UDID]);
  assert.match(calls[1].args.join(' '), /status_bar/);
  assert.match(calls[1].args.join(' '), /--time 09:41/);
});

test('launch: iOS の boot 失敗は ok:false + error を返す', async () => {
  const run = fakeRun([routeCmd('xcrun', ['simctl', 'boot'], { code: 149, stderr: 'Invalid device' })]);

  const handle = await launch({ kind: 'ios', profile: { platform: 'ios', udid: UDID } }, { run });

  assert.equal(handle.ok, false);
  assert.equal(handle.pid, null);
  assert.equal(handle.error.code, 149);
  assert.equal(handle.error.stderr, 'Invalid device');
});

/* ------------------------------------------------------------------ */
/* sampleFps                                                           */
/* ------------------------------------------------------------------ */

test('sampleFps: gfxinfo framestats をパースして FPS を返す', async () => {
  const calls = [];
  const run = fakeRun(
    [routeCmd('adb.exe', ['-s', 'emulator-5554', 'shell', 'dumpsys', 'gfxinfo', 'com.example.game', 'framestats'], {
      code: 0,
      stdout: GFXINFO_FIXTURE,
    })],
    calls,
  );

  const result = await sampleFps('emulator-5554', {
    run,
    adbPath: 'adb.exe',
    packageName: 'com.example.game',
  });

  assert.equal(result.method, 'gfxinfo');
  assert.equal(result.fps, 50);
  assert.deepEqual(result.samples, [50, 50, 50]);
  assert.equal(calls.length, 1);
});

test('sampleFps: 壊れた gfxinfo 出力は samples 空 + unavailable', async () => {
  const run = fakeRun([
    routeCmd('adb.exe', ['-s', 'emulator-5554', 'shell', 'dumpsys', 'gfxinfo'], {
      code: 0,
      stdout: 'garbage output without any PROFILEDATA block\n',
    }),
  ]);

  const result = await sampleFps('emulator-5554', {
    run,
    adbPath: 'adb.exe',
    packageName: 'com.example.game',
  });

  assert.deepEqual(result, { fps: null, method: 'unavailable', samples: [] });
});

test('sampleFps: FrameCompleted 列の無いヘッダは unavailable', async () => {
  const run = fakeRun([
    routeCmd('adb.exe', ['-s', 'emulator-5554', 'shell', 'dumpsys', 'gfxinfo'], {
      code: 0,
      stdout: '---PROFILEDATA---\nFlags,Vsync\n0,1\n0,2\n---PROFILEDATA---\n',
    }),
  ]);

  const result = await sampleFps('emulator-5554', { run, adbPath: 'adb.exe' });

  assert.deepEqual(result, { fps: null, method: 'unavailable', samples: [] });
});

test('sampleFps: adb 失敗・例外でも unavailable（throw しない）', async () => {
  const failed = await sampleFps('emulator-5554', {
    run: fakeRun([routeCmd('adb.exe', [], { code: 1, stderr: 'device offline' })]),
    adbPath: 'adb.exe',
  });
  assert.deepEqual(failed, { fps: null, method: 'unavailable', samples: [] });

  const rejected = await sampleFps('emulator-5554', {
    run: async () => {
      throw new Error('adb crashed');
    },
  });
  assert.deepEqual(rejected, { fps: null, method: 'unavailable', samples: [] });
});

test('sampleFps: iOS は simctl spawn log から FPS を拾う', async () => {
  const run = fakeRun([
    routeCmd('xcrun', ['simctl', 'spawn', UDID, 'log'], {
      code: 0,
      stdout: [
        '2026-11-17 17:00:00.000 I/Harness: FPS: 58.5',
        '2026-11-17 17:00:01.000 I/Harness: FPS: 57.5',
      ].join('\n'),
    }),
  ]);

  const result = await sampleFps(UDID, { run });

  assert.equal(result.method, 'simctl');
  assert.equal(result.fps, 58);
  assert.deepEqual(result.samples, [58.5, 57.5]);
});

test('sampleFps: iOS のログに FPS が無ければ unavailable', async () => {
  const run = fakeRun([
    routeCmd('xcrun', ['simctl', 'spawn', UDID, 'log'], { code: 0, stdout: 'nothing useful here\n' }),
  ]);

  const result = await sampleFps(UDID, { run });

  assert.deepEqual(result, { fps: null, method: 'unavailable', samples: [] });
});

/* ------------------------------------------------------------------ */
/* shutdown                                                            */
/* ------------------------------------------------------------------ */

test('shutdown: Android は adb emu kill を呼ぶ', async () => {
  const calls = [];
  const run = fakeRun([routeCmd('adb.exe', ['-s', 'emulator-5554', 'emu', 'kill'], { code: 0 })], calls);

  const result = await shutdown({ kind: 'android', serial: 'emulator-5554' }, { run, adbPath: 'adb.exe' });

  assert.equal(result.ok, true);
  assert.deepEqual(calls[0].args, ['-s', 'emulator-5554', 'emu', 'kill']);
  assert.deepEqual(result.command, ['adb.exe', '-s', 'emulator-5554', 'emu', 'kill']);
});

test('shutdown: iOS は simctl shutdown を呼び、失敗時は ok:false', async () => {
  const calls = [];
  const run = fakeRun([routeCmd('xcrun', ['simctl', 'shutdown'], { code: 149, stderr: 'No such device' })], calls);

  const result = await shutdown({ kind: 'ios', udid: UDID }, { run });

  assert.equal(result.ok, false);
  assert.equal(result.code, 149);
  assert.deepEqual(calls[0].args, ['simctl', 'shutdown', UDID]);
});
