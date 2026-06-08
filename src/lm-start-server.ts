'use strict';

import {loadBrokerRuntimeConfig, BrokerRuntimeConfigError} from "./broker-runtime-config";
import * as fs from 'fs';
import chalk from "chalk";
import * as path from "path";

let runtimeConfig: ReturnType<typeof loadBrokerRuntimeConfig>;

try {
  runtimeConfig = loadBrokerRuntimeConfig();
} catch (err) {
  const prefix = chalk.red.bold('lmx broker error:');
  if (err instanceof BrokerRuntimeConfigError) {
    console.error(prefix, err.message);
  } else {
    const e = err as Error;
    console.error(prefix, e && (e.stack || e.message) || String(err));
  }
  process.exit(1);
}

if (runtimeConfig.helpRequested) {
  runtimeConfig.printHelp(process.stdout);
  process.exit(0);
}

Object.assign(process.env, runtimeConfig.env);

const {initOtel, routineEnter, shutdownOtel} = require('./routine') as typeof import('./routine');
const {inspectError} = require('./shared-internal') as typeof import('./shared-internal');

// Initialise OpenTelemetry before any broker spans get created. Reads
// `OTEL_EXPORTER_OTLP_ENDPOINT` from the environment; no-op when unset,
// so dev/test runs stay quiet.
initOtel();
{
  const routineId = 'ddl-routine-lm-start-server-Hp9zQ';
  routineEnter(routineId, 'lm-start-server-bootstrap');
}

const {Broker1, log} = require('./broker-1') as typeof import('./broker-1');
const {LMXHttpServer} = require('./http-server') as typeof import('./http-server');

const v = {...runtimeConfig.broker} as any;

if (v.udsPath) {
  v.udsPath = path.resolve(v.udsPath);
  const udsDir = path.dirname(v.udsPath);
  
  try {
    fs.mkdirSync(udsDir, {recursive: true});
  }
  catch (err) {
    log.error(`Could not create UDS dir at '${udsDir}'.`);
    log.error(err);
    process.exit(1);
  }
  
  try {
    fs.unlinkSync(v.udsPath);
  } catch (err) {
     // ignore
  }
}

if (!Number.isInteger(v.port)) {
  log.error(chalk.magenta('Live-mutex: port could not be parsed to integer from command line input.'));
  log.error('Usage: lmx-start-server <key> <?port>');
  process.exit(1);
}

process.once('warning' as any, function (e: any) {
  if(process.env.lmx_log_errors != 'nope') {
    log.error('process warning:', chalk.magenta(inspectError(e)));
  }
});

process.once('unhandledRejection', function (e: any) {
  if(process.env.lmx_log_errors != 'nope') {
    log.error('unhandled-rejection:', chalk.magenta(inspectError(e)));
  }
});

process.once('uncaughtException', function (e: any) {
  if(process.env.lmx_log_errors != 'nope') {
    log.error('uncaught-exception:', chalk.magenta(inspectError(e)));
  }
});

const b = new Broker1(v);

process.once('exit', function () {
  const routineId = 'ddl-routine-lm-start-server-exit-Tr4';
  routineEnter(routineId, 'lm-start-server.onExit');
  // OTel flush is best-effort; the SDK runs `shutdown()` async but `exit`
  // handlers must be sync, so we kick it off and don't await — any
  // in-flight spans get a few hundred ms of wall time before the process
  // tears down listeners.
  shutdownOtel().catch(() => {});
  b.close(null);
});

b.emitter.on('warning', function () {
  log.warn(...arguments);
});

b.emitter.on('error', function () {
  log.error(...arguments);
});


b.ensure().then(async b => {

   log.info(chalk.bold('LMX broker version:'), chalk.blueBright(b.getVersion()));
   log.info(chalk.bold('LMX broker listening on:'), chalk.cyan.bold(String(b.getListeningInterface())));

   // Optional HTTP front-end. Off by default to avoid surprising
   // existing deployments. The runtime config module reconciles
   // `LMX_HTTP_*` env vars with `--http-*` CLI flags before we get here.
   if (runtimeConfig.http.enabled) {
       const httpPort = runtimeConfig.http.port as number;
       const httpHost = runtimeConfig.http.host;
       const httpServer = new LMXHttpServer(b, {
           enableHtmlStatus: runtimeConfig.http.enableHtmlStatus,
           host: httpHost,
           maxBodyBytes: runtimeConfig.http.maxBodyBytes,
           port: httpPort,
           requestTimeoutMs: runtimeConfig.http.requestTimeoutMs,
       });
       try {
           await httpServer.start();
           log.info(chalk.bold('LMX HTTP status server listening on:'),
               chalk.cyan.bold(`http://${httpHost}:${httpPort}/`));
           process.once('exit', () => { httpServer.stop().catch(() => {}); });
       } catch (err) {
           log.error('HTTP server failed to start:', inspectError(err as Error));
       }
   }
})
 .catch(function (err) {
   log.error('broker launch error:', inspectError(err));
   process.exit(1);
 });
