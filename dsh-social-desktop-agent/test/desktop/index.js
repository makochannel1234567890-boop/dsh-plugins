/**
 * Directory entry point for the desktop test suite.
 *
 * Node 24 resolves a directory positional argument of `node --test` as a single
 * entry module instead of traversing it, so `node --test <this dir>` lands here
 * and this file imports every test module. That keeps the documented acceptance
 * command working without a wrapper script. Individual files still run on their
 * own with a glob (`node --test "test/desktop/*.test.mjs"`).
 */

import './win.test.mjs';
import './observe.test.mjs';
import './input.test.mjs';
import './apps.test.mjs';
import './power.test.mjs';
import './tools.test.mjs';
