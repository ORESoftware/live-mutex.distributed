#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');

const {
  DEFAULT_BROKER_HOST,
  DEFAULT_BROKER_PORT,
  defaultUdsPath,
  loadBrokerRuntimeConfig,
} = require('../dist/broker-runtime-config');

const configPath = path.resolve(__dirname, '..', '.cli-flags.toml');

function load(argv, env) {
  return loadBrokerRuntimeConfig({
    argv: ['node', '/tmp/lmx_start_server.js', ...argv],
    configPath,
    env: env || {},
  });
}

function throwsLike(label, fn, pattern) {
  assert.throws(fn, pattern, label);
  console.log(`  ok - ${label}`);
}

function ok(label) {
  console.log(`  ok - ${label}`);
}

{
  const cfg = load([]);
  assert.strictEqual(cfg.broker.host, DEFAULT_BROKER_HOST);
  assert.strictEqual(cfg.broker.port, DEFAULT_BROKER_PORT);
  assert.strictEqual(cfg.broker.noDelay, true);
  assert.strictEqual(cfg.http.enabled, false);
  ok('defaults are applied in TypeScript, not TOML parser output');
}

{
  const cfg = load(['--port=7011'], {live_mutex_port: '7010'});
  assert.strictEqual(cfg.broker.port, 7011);
  assert.strictEqual(cfg.cliEnv.live_mutex_port, '7011');
  ok('CLI flags override same typed env vars');
}

{
  const cfg = load([], {LMX_PORT: '7012', LMX_HOST: '127.0.0.1'});
  assert.strictEqual(cfg.broker.port, 7012);
  assert.strictEqual(cfg.broker.host, '127.0.0.1');
  ok('broker accepts common LMX_PORT/LMX_HOST env aliases');
}

{
  const cfg = load(['--json', '{"port":7013,"host":"127.0.0.2"}']);
  assert.strictEqual(cfg.broker.port, 7013);
  assert.strictEqual(cfg.broker.host, '127.0.0.2');
  ok('legacy --json broker config still works');
}

{
  const cfg = load(['--json', '{"port":7014}', '--port=7015']);
  assert.strictEqual(cfg.broker.port, 7015);
  ok('direct CLI flags override legacy --json');
}

{
  const cfg = load(['--use-uds']);
  assert.strictEqual(cfg.broker.udsPath, defaultUdsPath());
  ok('--use-uds supplies the default socket path');
}

{
  const cfg = load(['--use-uds', '--uds-path=/tmp/lmx.sock']);
  assert.strictEqual(cfg.broker.udsPath, '/tmp/lmx.sock');
  ok('--uds-path overrides the default UDS path');
}

{
  const cfg = load([
    '--http-port=7016',
    '--http-host=127.0.0.3',
    '--http-max-body-bytes=8192',
    '--http-request-timeout-ms=1234',
    '--no-http-html-status',
  ]);
  assert.strictEqual(cfg.http.enabled, true);
  assert.strictEqual(cfg.http.port, 7016);
  assert.strictEqual(cfg.http.host, '127.0.0.3');
  assert.strictEqual(cfg.http.maxBodyBytes, 8192);
  assert.strictEqual(cfg.http.requestTimeoutMs, 1234);
  assert.strictEqual(cfg.http.enableHtmlStatus, false);
  ok('HTTP flags reconcile to typed HTTP config');
}

{
  const cfg = load(['--lmx-debug', '--no-log-errors']);
  assert.strictEqual(cfg.env.lmx_debug, 'yes');
  assert.strictEqual(cfg.cliEnv.lmx_debug, 'yes');
  assert.strictEqual(cfg.env.lmx_log_errors, 'nope');
  assert.strictEqual(cfg.cliEnv.lmx_log_errors, 'nope');
  ok('legacy boolean env values are normalized for broker internals');
}

{
  const cfg = load([], {lmx_log_errors: 'nope'});
  assert.strictEqual(cfg.env.lmx_log_errors, 'nope');
  ok('legacy lmx_log_errors=nope env remains supported');
}

{
  const cfg = load([
    '--admin-token=secret',
    '--log-level=warn',
    '--otel-endpoint=http://otel.example:4317',
    '--otel-service-name=lmx-test',
    '--otel-resource-attributes=deployment.environment=test',
    '--otel-log-level=debug',
  ]);
  assert.strictEqual(cfg.env.LMX_ADMIN_TOKEN, 'secret');
  assert.strictEqual(cfg.env.LMX_LOG_LEVEL, 'warn');
  assert.strictEqual(cfg.env.OTEL_EXPORTER_OTLP_ENDPOINT, 'http://otel.example:4317');
  assert.strictEqual(cfg.env.OTEL_SERVICE_NAME, 'lmx-test');
  assert.strictEqual(cfg.env.OTEL_RESOURCE_ATTRIBUTES, 'deployment.environment=test');
  assert.strictEqual(cfg.env.OTEL_LOG_LEVEL, 'debug');
  ok('admin, log, and OTel flags map to broker env vars');
}

throwsLike('invalid port is rejected', () => load(['--port=1024']), /live_mutex_port/);
throwsLike('invalid log level is rejected', () => load(['--log-level=verbose']), /LMX_LOG_LEVEL/);
throwsLike('unknown flags are rejected', () => load(['--definitely-not-a-real-flag']), /Unknown broker CLI/);

{
  const cfg = load(['--help']);
  assert.strictEqual(cfg.helpRequested, true);
  const table = cfg.printHelp({columns: 120, write() {}});
  assert.ok(table.includes('--http-port'));
  assert.ok(table.includes('--otel-endpoint'));
  ok('help table includes hardened broker flags');
}

console.log('\nbroker-runtime-config-test: all checks passed');
