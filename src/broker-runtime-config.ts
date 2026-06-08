'use strict';

import * as os from 'os';
import * as path from 'path';
import type {IBrokerOptsPartial} from './broker-1';

type EnvMap = {[key: string]: string | undefined};
type CliEnvOverrides = {[key: string]: string};

export interface BrokerRuntimeEnv extends EnvMap {
    FLAGS2ENV_CONFIG?: string;
    LMX_ADMIN_TOKEN?: string;
    LMX_BROKER_CONFIG_JSON?: string;
    LMX_CLI_PARSE_ERRORS?: string;
    LMX_CLI_UNKNOWN_OPTIONS?: string;
    LMX_HTTP_HTML_STATUS?: string;
    LMX_HTTP_HOST?: string;
    LMX_HTTP_MAX_BODY_BYTES?: string;
    LMX_HTTP_PORT?: string;
    LMX_HTTP_REQUEST_TIMEOUT_MS?: string;
    LMX_LOG_LEVEL?: string;
    OTEL_EXPORTER_OTLP_ENDPOINT?: string;
    OTEL_LOG_LEVEL?: string;
    OTEL_RESOURCE_ATTRIBUTES?: string;
    OTEL_SERVICE_NAME?: string;
    lmx_host?: string;
    lmx_log_errors?: string;
    lmx_port?: string;
    LMX_HOST?: string;
    LMX_PORT?: string;
    live_mutex_host?: string;
    live_mutex_lock_expires_after?: string;
    live_mutex_no_delay?: string;
    live_mutex_port?: string;
    live_mutex_timeout_to_find_new_lockholder?: string;
    live_mutex_uds_path?: string;
    lmx_debug?: string;
    use_uds?: string;
}

export interface BrokerRuntimeHttpConfig {
    enableHtmlStatus: boolean;
    enabled: boolean;
    host: string;
    maxBodyBytes?: number;
    port?: number;
    requestTimeoutMs?: number;
}

export interface TableWriter {
    columns?: number;
    write(chunk: string): unknown;
}

export interface BrokerRuntimeConfig {
    broker: IBrokerOptsPartial;
    cliEnv: CliEnvOverrides;
    configPath: string;
    env: BrokerRuntimeEnv;
    helpRequested: boolean;
    http: BrokerRuntimeHttpConfig;
    printHelp(target?: TableWriter): string;
}

export interface LoadBrokerRuntimeConfigOpts {
    argv?: readonly unknown[];
    configPath?: string;
    env?: EnvMap;
}

interface Flags2EnvParseResult {
    readonly isHelpMenu: boolean;
    printTable(target?: TableWriter): string;
    [key: string]: unknown;
}

interface Flags2EnvModule {
    parse(argv?: readonly unknown[], opts?: {configPath?: string}): Flags2EnvParseResult;
}

export class BrokerRuntimeConfigError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'BrokerRuntimeConfigError';
    }
}

export const DEFAULT_BROKER_HOST = '0.0.0.0';
export const DEFAULT_BROKER_PORT = 6970;
export const DEFAULT_HTTP_HOST = '0.0.0.0';
export const DEFAULT_LOCK_EXPIRES_AFTER = 5000;
export const DEFAULT_TIMEOUT_TO_FIND_NEW_LOCKHOLDER = 4500;
export const DEFAULT_CLI_FLAGS_CONFIG_PATH = path.resolve(__dirname, '..', '.cli-flags.toml');
const VALID_LOG_LEVELS = ['silent', 'error', 'warn', 'info', 'debug', 'trace'];

const flags2Env = require('@oresoftware/f2e') as Flags2EnvModule;

export function defaultUdsPath(): string {
    return path.resolve(os.homedir(), '.lmx', 'uds.sock');
}

export function loadBrokerRuntimeConfig(opts: LoadBrokerRuntimeConfigOpts = {}): BrokerRuntimeConfig {
    const env = normalizeRuntimeEnv(stringEnvMap(opts.env || process.env));
    const argv = normalizeArgv(opts.argv || process.argv);
    const configPath = opts.configPath || env.FLAGS2ENV_CONFIG || DEFAULT_CLI_FLAGS_CONFIG_PATH;
    const parsed = flags2Env.parse(argv, {configPath});
    const cliEnv = normalizeRuntimeEnv(enumerableStringMap(parsed));
    const mergedEnv = {...env, ...cliEnv} as BrokerRuntimeEnv;
    const parseErrors = readJsonStringArray(mergedEnv.LMX_CLI_PARSE_ERRORS, 'LMX_CLI_PARSE_ERRORS');
    const unknownOptions = readJsonStringArray(mergedEnv.LMX_CLI_UNKNOWN_OPTIONS, 'LMX_CLI_UNKNOWN_OPTIONS');

    if (!parsed.isHelpMenu && parseErrors.length > 0) {
        throw new BrokerRuntimeConfigError(`Could not parse broker CLI flags: ${parseErrors.join('; ')}`);
    }

    if (!parsed.isHelpMenu && unknownOptions.length > 0) {
        throw new BrokerRuntimeConfigError(`Unknown broker CLI flag(s): ${unknownOptions.join(', ')}`);
    }

    validateRuntimeEnv(mergedEnv);

    const broker = brokerConfigFromEnv(mergedEnv);
    applyBrokerJsonConfig(broker, mergedEnv.LMX_BROKER_CONFIG_JSON);
    applyDirectCliBrokerOverrides(broker, cliEnv);

    return {
        broker,
        cliEnv,
        configPath,
        env: mergedEnv,
        helpRequested: parsed.isHelpMenu,
        http: httpConfigFromEnv(mergedEnv),
        printHelp: parsed.printTable.bind(parsed)
    };
}

function enumerableStringMap(value: {[key: string]: unknown}): CliEnvOverrides {
    const result = <CliEnvOverrides>{};

    for (const key of Object.keys(value)) {
        const entry = value[key];
        if (typeof entry === 'string') {
            result[key] = entry;
        }
    }

    return result;
}

function stringEnvMap(value: EnvMap): CliEnvOverrides {
    const result = <CliEnvOverrides>{};

    for (const key of Object.keys(value)) {
        const entry = value[key];
        if (typeof entry === 'string') {
            result[key] = entry;
        }
    }

    return result;
}

function normalizeRuntimeEnv<T extends EnvMap>(env: T): T {
    const result = {...env} as EnvMap;

    if (hasOwn(result, 'lmx_debug')) {
        result.lmx_debug = readBooleanValue(result.lmx_debug, 'lmx_debug') ? 'yes' : 'no';
    }

    if (hasOwn(result, 'lmx_log_errors')) {
        result.lmx_log_errors = readLegacyLogErrorsValue(result.lmx_log_errors) ? 'yes' : 'nope';
    }

    return result as T;
}

function validateRuntimeEnv(env: BrokerRuntimeEnv): void {
    if (hasEnvValue(env.LMX_LOG_LEVEL)) {
        const level = env.LMX_LOG_LEVEL.trim().toLowerCase();
        if (VALID_LOG_LEVELS.indexOf(level) < 0) {
            throw new BrokerRuntimeConfigError(
                `LMX_LOG_LEVEL must be one of: ${VALID_LOG_LEVELS.join(', ')}.`
            );
        }
    }
}

function normalizeArgv(argv: readonly unknown[]): string[] {
    const items = argv.map(String);

    if (items.length >= 2 && /(^|[/\\])node(\.exe)?$/i.test(items[0])) {
        return [path.basename(items[1]), ...items.slice(2)];
    }

    return items;
}

function brokerConfigFromEnv(env: BrokerRuntimeEnv): IBrokerOptsPartial {
    const broker: IBrokerOptsPartial = {
        host: readString(firstEnv(env, ['live_mutex_host', 'LMX_HOST', 'lmx_host']), 'live_mutex_host') ||
            DEFAULT_BROKER_HOST,
        lockExpiresAfter: readInteger(env.live_mutex_lock_expires_after, 'live_mutex_lock_expires_after',
            DEFAULT_LOCK_EXPIRES_AFTER, 21, 3999999),
        noDelay: readBoolean(env.live_mutex_no_delay, 'live_mutex_no_delay', true),
        port: readInteger(firstEnv(env, ['live_mutex_port', 'LMX_PORT', 'lmx_port']), 'live_mutex_port',
            DEFAULT_BROKER_PORT, 1025, 49151),
        timeoutToFindNewLockholder: readInteger(env.live_mutex_timeout_to_find_new_lockholder,
            'live_mutex_timeout_to_find_new_lockholder', DEFAULT_TIMEOUT_TO_FIND_NEW_LOCKHOLDER, 21, 3999999)
    };

    const useUDS = readOptionalBoolean(env.use_uds, 'use_uds');
    const udsPath = readString(env.live_mutex_uds_path, 'live_mutex_uds_path');

    if (useUDS === true) {
        broker.udsPath = udsPath ? path.resolve(udsPath) : defaultUdsPath();
    } else if (udsPath) {
        broker.udsPath = path.resolve(udsPath);
    }

    return broker;
}

function applyBrokerJsonConfig(broker: IBrokerOptsPartial, raw: string | undefined): void {
    if (!raw) {
        return;
    }

    let parsed: unknown;

    try {
        parsed = JSON.parse(raw);
    } catch (err) {
        const e = err as Error;
        throw new BrokerRuntimeConfigError(`LMX_BROKER_CONFIG_JSON could not be parsed as JSON: ${e.message}`);
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new BrokerRuntimeConfigError('LMX_BROKER_CONFIG_JSON must be a JSON object.');
    }

    const value = parsed as {[key: string]: unknown};

    if (hasOwn(value, 'host')) {
        broker.host = readStringValue(value.host, 'LMX_BROKER_CONFIG_JSON.host');
    }

    if (hasOwn(value, 'port')) {
        broker.port = readIntegerValue(value.port, 'LMX_BROKER_CONFIG_JSON.port', 1025, 49151);
    }

    if (hasOwn(value, 'lockExpiresAfter')) {
        broker.lockExpiresAfter = readIntegerValue(value.lockExpiresAfter,
            'LMX_BROKER_CONFIG_JSON.lockExpiresAfter', 21, 3999999);
    }

    if (hasOwn(value, 'timeoutToFindNewLockholder')) {
        broker.timeoutToFindNewLockholder = readIntegerValue(value.timeoutToFindNewLockholder,
            'LMX_BROKER_CONFIG_JSON.timeoutToFindNewLockholder', 21, 3999999);
    }

    if (hasOwn(value, 'noDelay')) {
        broker.noDelay = readBooleanValue(value.noDelay, 'LMX_BROKER_CONFIG_JSON.noDelay');
    }

    if (hasOwn(value, 'noListen')) {
        broker.noListen = readBooleanValue(value.noListen, 'LMX_BROKER_CONFIG_JSON.noListen');
    }

    if (hasOwn(value, 'udsPath')) {
        const udsPath = readStringValue(value.udsPath, 'LMX_BROKER_CONFIG_JSON.udsPath');
        broker.udsPath = path.resolve(udsPath);
    }
}

function applyDirectCliBrokerOverrides(broker: IBrokerOptsPartial, cliEnv: CliEnvOverrides): void {
    if (hasOwn(cliEnv, 'live_mutex_host')) {
        broker.host = readStringValue(cliEnv.live_mutex_host, 'live_mutex_host');
    }

    if (hasOwn(cliEnv, 'live_mutex_port')) {
        broker.port = readIntegerValue(cliEnv.live_mutex_port, 'live_mutex_port', 1025, 49151);
    }

    if (hasOwn(cliEnv, 'live_mutex_lock_expires_after')) {
        broker.lockExpiresAfter = readIntegerValue(cliEnv.live_mutex_lock_expires_after,
            'live_mutex_lock_expires_after', 21, 3999999);
    }

    if (hasOwn(cliEnv, 'live_mutex_timeout_to_find_new_lockholder')) {
        broker.timeoutToFindNewLockholder = readIntegerValue(cliEnv.live_mutex_timeout_to_find_new_lockholder,
            'live_mutex_timeout_to_find_new_lockholder', 21, 3999999);
    }

    if (hasOwn(cliEnv, 'live_mutex_no_delay')) {
        broker.noDelay = readBooleanValue(cliEnv.live_mutex_no_delay, 'live_mutex_no_delay');
    }

    if (hasOwn(cliEnv, 'use_uds')) {
        if (readBooleanValue(cliEnv.use_uds, 'use_uds')) {
            broker.udsPath = broker.udsPath || defaultUdsPath();
        } else {
            delete broker.udsPath;
        }
    }

    if (hasOwn(cliEnv, 'live_mutex_uds_path')) {
        broker.udsPath = path.resolve(readStringValue(cliEnv.live_mutex_uds_path, 'live_mutex_uds_path'));
    }
}

function httpConfigFromEnv(env: BrokerRuntimeEnv): BrokerRuntimeHttpConfig {
    const host = readString(env.LMX_HTTP_HOST, 'LMX_HTTP_HOST') || DEFAULT_HTTP_HOST;
    const maxBodyBytes = readOptionalInteger(env.LMX_HTTP_MAX_BODY_BYTES, 'LMX_HTTP_MAX_BODY_BYTES',
        1, 10 * 1024 * 1024);
    const requestTimeoutMs = readOptionalInteger(env.LMX_HTTP_REQUEST_TIMEOUT_MS, 'LMX_HTTP_REQUEST_TIMEOUT_MS',
        1, 24 * 60 * 60 * 1000);
    const enableHtmlStatus = readBoolean(env.LMX_HTTP_HTML_STATUS, 'LMX_HTTP_HTML_STATUS', true);

    if (!hasEnvValue(env.LMX_HTTP_PORT)) {
        return {enableHtmlStatus, enabled: false, host, maxBodyBytes, requestTimeoutMs};
    }

    return {
        enableHtmlStatus,
        enabled: true,
        host,
        maxBodyBytes,
        port: readInteger(env.LMX_HTTP_PORT, 'LMX_HTTP_PORT', undefined, 1, 65535),
        requestTimeoutMs
    };
}

function readString(value: string | undefined, name: string): string | undefined {
    if (!hasEnvValue(value)) {
        return undefined;
    }

    return readStringValue(value, name);
}

function readStringValue(value: unknown, name: string): string {
    if (typeof value !== 'string') {
        throw new BrokerRuntimeConfigError(`${name} must be a string.`);
    }

    return value;
}

function readInteger(
    value: string | undefined,
    name: string,
    defaultValue: number | undefined,
    min: number,
    max: number
): number {
    if (!hasEnvValue(value)) {
        if (defaultValue === undefined) {
            throw new BrokerRuntimeConfigError(`${name} must be set.`);
        }
        return defaultValue;
    }

    return readIntegerValue(value, name, min, max);
}

function readOptionalInteger(value: string | undefined, name: string, min: number, max: number): number | undefined {
    if (!hasEnvValue(value)) {
        return undefined;
    }

    return readIntegerValue(value, name, min, max);
}

function readIntegerValue(value: unknown, name: string, min: number, max: number): number {
    let n: number;

    if (typeof value === 'number') {
        n = value;
    } else if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
        n = Number.parseInt(value, 10);
    } else {
        throw new BrokerRuntimeConfigError(`${name} must be an integer.`);
    }

    if (!Number.isInteger(n) || n < min || n > max) {
        throw new BrokerRuntimeConfigError(`${name} must be an integer in range ${min}..${max}.`);
    }

    return n;
}

function readBoolean(value: string | undefined, name: string, defaultValue: boolean): boolean {
    const parsed = readOptionalBoolean(value, name);
    return parsed === undefined ? defaultValue : parsed;
}

function readOptionalBoolean(value: string | undefined, name: string): boolean | undefined {
    if (!hasEnvValue(value)) {
        return undefined;
    }

    return readBooleanValue(value, name);
}

function readBooleanValue(value: unknown, name: string): boolean {
    if (typeof value === 'boolean') {
        return value;
    }

    if (typeof value !== 'string') {
        throw new BrokerRuntimeConfigError(`${name} must be a boolean.`);
    }

    const normalized = value.trim().toLowerCase();

    if (['true', 't', '1', 'yes', 'y', 'on'].indexOf(normalized) >= 0) {
        return true;
    }

    if (['false', 'f', '0', 'no', 'n', 'off'].indexOf(normalized) >= 0) {
        return false;
    }

    throw new BrokerRuntimeConfigError(`${name} must be a boolean.`);
}

function readLegacyLogErrorsValue(value: unknown): boolean {
    if (typeof value === 'string' && value.trim().toLowerCase() === 'nope') {
        return false;
    }

    return readBooleanValue(value, 'lmx_log_errors');
}

function readJsonStringArray(value: string | undefined, name: string): string[] {
    if (!hasEnvValue(value)) {
        return [];
    }

    let parsed: unknown;

    try {
        parsed = JSON.parse(value);
    } catch (err) {
        const e = err as Error;
        throw new BrokerRuntimeConfigError(`${name} could not be parsed as JSON: ${e.message}`);
    }

    if (!Array.isArray(parsed)) {
        throw new BrokerRuntimeConfigError(`${name} must be a JSON array.`);
    }

    return parsed.map((item: unknown) => String(item));
}

function hasEnvValue(value: string | undefined): value is string {
    return value !== undefined && value !== '';
}

function hasOwn(obj: object, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(obj, key);
}

function firstEnv(env: BrokerRuntimeEnv, keys: string[]): string | undefined {
    for (const key of keys) {
        const value = env[key];
        if (hasEnvValue(value)) {
            return value;
        }
    }

    return undefined;
}
