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
const allowsUnknownConfigPath = path.resolve(__dirname, 'fixtures', 'broker-cli-allows-unknown.toml');
const compatibleCustomConfigPath = path.resolve(__dirname, 'fixtures', 'broker-cli-compatible-custom.toml');
const defaultedConfigPath = path.resolve(__dirname, 'fixtures', 'broker-cli-with-default.toml');
const typeDriftConfigPath = path.resolve(__dirname, 'fixtures', 'broker-cli-with-type-drift.toml');

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
  assert.strictEqual(cfg.http.enableHtmlStatus, true);
  assert.strictEqual(cfg.values.LMX_HTTP_HTML_STATUS, undefined);
  ok('domain defaults remain authoritative when the schema value is absent');
}

{
  const cfg = load(['--port=7011'], {live_mutex_port: '7010'});
  assert.strictEqual(cfg.broker.port, 7011);
  assert.strictEqual(cfg.cliEnv.live_mutex_port, '7011');
  assert.strictEqual(cfg.values.live_mutex_port, 7011);
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

throwsLike(
  'custom schema defaults are rejected before they can impersonate CLI overrides',
  () => loadBrokerRuntimeConfig({
    argv: ['node', '/tmp/lmx_start_server.js'],
    configPath: defaultedConfigPath,
    env: {
      live_mutex_port: '7016',
      LMX_BROKER_CONFIG_JSON: '{"port":7017}',
    },
  }),
  /defines schema defaults for: live_mutex_port.*override environment or JSON values/
);

throwsLike(
  'custom schemas cannot suppress unknown-option reporting',
  () => loadBrokerRuntimeConfig({
    argv: ['node', '/tmp/lmx_start_server.js'],
    configPath: allowsUnknownConfigPath,
    env: {},
  }),
  /must report unknown options.*allow_unknown = false/
);

throwsLike(
  'custom schema type drift is rejected before coercion can diverge from the generated interface',
  () => loadBrokerRuntimeConfig({
    argv: ['node', '/tmp/lmx_start_server.js'],
    configPath: typeDriftConfigPath,
    env: {live_mutex_port: '7018'},
  }),
  /live_mutex_port \(expected integer, got string\)/
);

{
  const cfg = loadBrokerRuntimeConfig({
    argv: ['node', '/tmp/lmx_start_server.js', '--custom-port=7020'],
    configPath: compatibleCustomConfigPath,
    env: {
      live_mutex_port: '7019',
      LMX_BROKER_CONFIG_JSON: '{"port":7021}',
      lmx_log_errors: 'nope',
    },
  });
  assert.strictEqual(cfg.broker.port, 7020);
  assert.strictEqual(cfg.values.lmx_log_errors, false);
  ok('compatible custom aliases preserve CLI precedence and canonical boolean semantics');
}

throwsLike(
  'compatible custom parser channels still reject unknown options',
  () => loadBrokerRuntimeConfig({
    argv: ['node', '/tmp/lmx_start_server.js', '--wat=TOPSECRET'],
    configPath: compatibleCustomConfigPath,
    env: {},
  }),
  /Unknown broker CLI flag\(s\): --wat$/
);

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
  assert.strictEqual(cfg.values.lmx_debug, true);
  assert.strictEqual(cfg.values.lmx_log_errors, false);
  ok('legacy boolean env values are normalized for broker internals');
}

{
  const cfg = load([], {lmx_log_errors: 'nope'});
  assert.strictEqual(cfg.env.lmx_log_errors, 'nope');
  ok('legacy lmx_log_errors=nope env remains supported');
}

{
  const cfg = load([], {
    LMX_HTTP_HTML_STATUS: ' N ',
    live_mutex_no_delay: ' OFF ',
    live_mutex_port: ' 7010 ',
    use_uds: ' YES ',
  });
  assert.strictEqual(cfg.broker.noDelay, false);
  assert.strictEqual(cfg.broker.port, 7010);
  assert.strictEqual(cfg.broker.udsPath, defaultUdsPath());
  assert.strictEqual(cfg.http.enableHtmlStatus, false);
  ok('legacy case-insensitive and whitespace-tolerant values remain supported');
}

{
  const cfg = load([], {LMX_HTTP_HTML_STATUS: '', live_mutex_port: ''});
  assert.strictEqual(cfg.broker.port, DEFAULT_BROKER_PORT);
  assert.strictEqual(cfg.http.enableHtmlStatus, true);
  assert.strictEqual(cfg.values.live_mutex_port, undefined);
  ok('empty environment values remain unset');
}

{
  const cfg = load([
    '--log-level=warn',
    '--otel-endpoint=http://otel.example:4317',
    '--otel-service-name=lmx-test',
    '--otel-resource-attributes=deployment.environment=test',
    '--otel-log-level=debug',
  ], {LMX_ADMIN_TOKEN: 'secret'});
  assert.strictEqual(cfg.env.LMX_ADMIN_TOKEN, 'secret');
  assert.strictEqual(cfg.values.LMX_ADMIN_TOKEN, undefined);
  assert.ok(!Object.prototype.hasOwnProperty.call(cfg.values, 'LMX_ADMIN_TOKEN'));
  assert.strictEqual(cfg.env.LMX_LOG_LEVEL, 'warn');
  assert.strictEqual(cfg.values.LMX_LOG_LEVEL, 'warn');
  assert.strictEqual(cfg.env.OTEL_EXPORTER_OTLP_ENDPOINT, 'http://otel.example:4317');
  assert.strictEqual(cfg.env.OTEL_SERVICE_NAME, 'lmx-test');
  assert.strictEqual(cfg.env.OTEL_RESOURCE_ATTRIBUTES, 'deployment.environment=test');
  assert.strictEqual(cfg.env.OTEL_LOG_LEVEL, 'debug');
  ok('environment-only admin token and non-secret flags map to broker config');
}

throwsLike('invalid port is rejected', () => load(['--port=1024']), /live_mutex_port/);
throwsLike(
  'invalid integer values fail schema coercion with key and table context',
  () => load([], {live_mutex_port: 'not-an-integer'}),
  /live_mutex_port \(flags\.port\) must be an integer/
);
throwsLike(
  'invalid boolean values fail schema coercion with key and table context',
  () => load([], {LMX_HTTP_HTML_STATUS: 'sometimes'}),
  /LMX_HTTP_HTML_STATUS \(flags\.http-html-status\) must be a boolean/
);
throwsLike(
  'invalid JSON values fail schema coercion with key and table context',
  () => load([], {LMX_BROKER_CONFIG_JSON: '{'}),
  /LMX_BROKER_CONFIG_JSON \(flags\.json\) must be valid JSON/
);
throwsLike('invalid log level is rejected', () => load(['--log-level=verbose']), /LMX_LOG_LEVEL/);

{
  let message = '';
  try {
    load(['--admin-token=TOPSECRET']);
    assert.fail('admin token CLI input should be rejected');
  } catch (error) {
    message = String(error.message || error);
  }
  assert.match(message, /Unknown broker CLI flag\(s\): --admin-token/);
  assert.ok(!message.includes('TOPSECRET'));
  ok('retired secret flag values are redacted from errors');
}

{
  let message = '';
  try {
    load(['-aTOPSECRET']);
    assert.fail('unknown compact option should be rejected');
  } catch (error) {
    message = String(error.message || error);
  }
  assert.match(message, /Unknown broker CLI flag\(s\): -a$/);
  assert.ok(!message.includes('TOPSECRET'));
  ok('unknown compact option payloads are redacted from errors');
}

throwsLike('unknown flags are rejected', () => load(['--definitely-not-a-real-flag']), /Unknown broker CLI/);

{
  const cfg = load(['--help']);
  assert.strictEqual(cfg.helpRequested, true);
  const table = cfg.printHelp({columns: 120, write() {}});
  assert.ok(table.includes('--http-port'));
  assert.ok(table.includes('--otel-endpoint'));
  assert.ok(!table.includes('--admin-token'));
  ok('help includes public broker flags and excludes the admin secret');
}

console.log('\nbroker-runtime-config-test: all checks passed');
