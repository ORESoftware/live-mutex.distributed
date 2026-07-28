'use strict';

import * as os from 'os';
import * as path from 'path';
import type {IBrokerOptsPartial} from './broker-1';
import type {BrokerCliConfig} from './generated/broker-cli-config';
import {
    BROKER_CLI_BOOLEAN_ENV_KEYS,
    BROKER_CLI_INTEGER_ENV_KEYS
} from './generated/broker-cli-config-metadata';

type EnvMap = {[key: string]: string | undefined};
type CliEnvOverrides = {[key: string]: string};

export interface BrokerRuntimeEnv extends EnvMap {
    FLAGS2ENV_CONFIG?: string;
    LMX_ADMIN_TOKEN?: string;
    lmx_host?: string;
    lmx_port?: string;
    LMX_HOST?: string;
    LMX_PORT?: string;
}

export interface BrokerRuntimeValues extends BrokerCliConfig {
    lmx_host?: string;
    lmx_port?: string;
    LMX_HOST?: string;
    LMX_PORT?: string;
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
    values: BrokerRuntimeValues;
}

export interface LoadBrokerRuntimeConfigOpts {
    argv?: readonly unknown[];
    configPath?: string;
    env?: EnvMap;
}

interface Flags2EnvParseResult {
    readonly errors: unknown[];
    readonly flags: {[key: string]: unknown};
    readonly isHelpMenu: boolean;
    readonly unknownOptions: unknown[];
    printTable(target?: TableWriter): string;
}

interface Flags2EnvJsonSchemaProperty {
    type?: unknown;
    'x-flags2env-type'?: unknown;
}

interface Flags2EnvJsonSchema {
    properties: {[key: string]: Flags2EnvJsonSchemaProperty};
    required: unknown[];
}

interface Flags2EnvModule {
    coerce<T extends object>(
        values: Readonly<{[key: string]: unknown}>,
        opts?: {configPath?: string}
    ): T;
    generateTypes(language: string, opts?: {configPath?: string; typeName?: string}): string;
    parseStructured(argv?: readonly unknown[], opts?: {configPath?: string}): Flags2EnvParseResult;
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
const BOOLEAN_ENV_KEYS = new Set<string>(BROKER_CLI_BOOLEAN_ENV_KEYS);
const INTEGER_ENV_KEYS = new Set<string>(BROKER_CLI_INTEGER_ENV_KEYS);

const flags2Env = require('@oresoftware/f2e') as Flags2EnvModule;

export function defaultUdsPath(): string {
    return path.resolve(os.homedir(), '.lmx', 'uds.sock');
}

export function loadBrokerRuntimeConfig(opts: LoadBrokerRuntimeConfigOpts = {}): BrokerRuntimeConfig {
    const env = normalizeRuntimeEnv(stringEnvMap(opts.env || process.env));
    const argv = normalizeArgv(opts.argv || process.argv);
    const configPath = opts.configPath || env.FLAGS2ENV_CONFIG || DEFAULT_CLI_FLAGS_CONFIG_PATH;
    assertCompatibleCliSchema(configPath);
    const parsed = flags2Env.parseStructured(argv, {configPath});
    const cliEnv = normalizeRuntimeEnv(enumerableStringMap(parsed.flags));
    const mergedEnv = {...env, ...cliEnv} as BrokerRuntimeEnv;
    const parseErrors = parsed.errors.map(String);
    const unknownOptions = parsed.unknownOptions.map(String);

    if (!parsed.isHelpMenu && parseErrors.length > 0) {
        throw new BrokerRuntimeConfigError(`Could not parse broker CLI flags: ${parseErrors.join('; ')}`);
    }

    if (!parsed.isHelpMenu && unknownOptions.length > 0) {
        throw new BrokerRuntimeConfigError(
            `Unknown broker CLI flag(s): ${unknownOptions.map(redactUnknownOption).join(', ')}`
        );
    }

    const mergedCoercionInput = coercionInputFrom(mergedEnv);
    const cliCoercionInput = coercionInputFrom(cliEnv);
    if (parsed.isHelpMenu) {
        delete mergedCoercionInput.LMX_CLI_PARSE_ERRORS;
        delete cliCoercionInput.LMX_CLI_PARSE_ERRORS;
    }
    const schemaValues = coerceCliConfig(mergedCoercionInput, configPath);
    const cliValues = coerceCliConfig(cliCoercionInput, configPath);
    const values: BrokerRuntimeValues = {
        ...schemaValues,
        lmx_host: mergedEnv.lmx_host,
        lmx_port: mergedEnv.lmx_port,
        LMX_HOST: mergedEnv.LMX_HOST,
        LMX_PORT: mergedEnv.LMX_PORT
    };

    validateRuntimeValues(values);

    const broker = brokerConfigFromValues(values);
    applyBrokerJsonConfig(broker, values.LMX_BROKER_CONFIG_JSON);
    applyDirectCliBrokerOverrides(broker, cliValues);

    return {
        broker,
        cliEnv,
        configPath,
        env: mergedEnv,
        helpRequested: parsed.isHelpMenu,
        http: httpConfigFromValues(values),
        printHelp: parsed.printTable.bind(parsed),
        values
    };
}

function assertCompatibleCliSchema(configPath: string): void {
    // Custom files may change flag names, aliases, help text, and parser channel names.
    // The generated runtime boundary still requires the canonical env keys/types,
    // reported unknown options, and no defaults so customizations cannot change
    // precedence or value shape.
    const selectedSchema = readGeneratedJsonSchema(configPath);
    assertSchemaHasNoDefaults(selectedSchema, configPath);
    assertUnknownOptionsReported(configPath);

    if (path.resolve(configPath) === path.resolve(DEFAULT_CLI_FLAGS_CONFIG_PATH)) {
        return;
    }

    const canonicalSchema = readGeneratedJsonSchema(DEFAULT_CLI_FLAGS_CONFIG_PATH);
    assertSchemaHasNoDefaults(canonicalSchema, DEFAULT_CLI_FLAGS_CONFIG_PATH);

    const selectedKeys = Object.keys(selectedSchema.properties).sort();
    const canonicalKeys = Object.keys(canonicalSchema.properties).sort();
    const missingKeys = canonicalKeys.filter(key => !hasOwn(selectedSchema.properties, key));
    const extraKeys = selectedKeys.filter(key => !hasOwn(canonicalSchema.properties, key));

    if (missingKeys.length > 0 || extraKeys.length > 0) {
        const details = [
            missingKeys.length > 0 ? `missing: ${missingKeys.join(', ')}` : '',
            extraKeys.length > 0 ? `extra: ${extraKeys.join(', ')}` : ''
        ].filter(Boolean).join('; ');
        throw new BrokerRuntimeConfigError(
            `Broker CLI config "${configPath}" does not match the generated broker interface (${details}).`
        );
    }

    const mismatchedTypes = canonicalKeys.filter(key => {
        return schemaPropertyType(selectedSchema.properties[key]) !==
            schemaPropertyType(canonicalSchema.properties[key]);
    });

    if (mismatchedTypes.length > 0) {
        const details = mismatchedTypes.map(key => {
            const expected = schemaPropertyType(canonicalSchema.properties[key]);
            const actual = schemaPropertyType(selectedSchema.properties[key]);
            return `${key} (expected ${expected}, got ${actual})`;
        }).join(', ');
        throw new BrokerRuntimeConfigError(
            `Broker CLI config "${configPath}" has types that do not match the generated broker interface: ${details}.`
        );
    }
}

function assertUnknownOptionsReported(configPath: string): void {
    const probe = '--__lmx_internal_unknown_option_probe_7f3c9d__';
    let parsed: Flags2EnvParseResult;

    try {
        parsed = flags2Env.parseStructured(['broker-runtime-config', probe], {configPath});
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new BrokerRuntimeConfigError(
            `Could not verify unknown-option handling for broker CLI config "${configPath}": ${message}`
        );
    }

    if (parsed.unknownOptions.map(String).indexOf(probe) < 0) {
        throw new BrokerRuntimeConfigError(
            `Broker CLI config "${configPath}" must report unknown options; ` +
            'set [parse].allow_unknown = false.'
        );
    }
}

function readGeneratedJsonSchema(configPath: string): Flags2EnvJsonSchema {
    let rawSchema: string;

    try {
        rawSchema = flags2Env.generateTypes('json-schema', {configPath});
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new BrokerRuntimeConfigError(
            `Could not inspect broker CLI config "${configPath}": ${message}`
        );
    }

    let value: unknown;

    try {
        value = JSON.parse(rawSchema);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new BrokerRuntimeConfigError(
            `flags2env generated invalid JSON Schema for "${configPath}": ${message}`
        );
    }

    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new BrokerRuntimeConfigError(
            `flags2env generated a non-object JSON Schema for "${configPath}".`
        );
    }

    const schema = value as Partial<Flags2EnvJsonSchema>;
    if (!schema.properties || typeof schema.properties !== 'object' ||
        Array.isArray(schema.properties) || !Array.isArray(schema.required)) {
        throw new BrokerRuntimeConfigError(
            `flags2env generated an incomplete JSON Schema for "${configPath}".`
        );
    }

    return schema as Flags2EnvJsonSchema;
}

function assertSchemaHasNoDefaults(schema: Flags2EnvJsonSchema, configPath: string): void {
    const defaultedKeys = schema.required.map(String);

    if (defaultedKeys.length > 0) {
        throw new BrokerRuntimeConfigError(
            `Broker CLI config "${configPath}" defines schema defaults for: ${defaultedKeys.join(', ')}. ` +
            'Defaults are unsupported because they can override environment or JSON values without an explicit CLI flag.'
        );
    }
}

function schemaPropertyType(property: Flags2EnvJsonSchemaProperty): string {
    const flags2EnvType = property['x-flags2env-type'];
    if (typeof flags2EnvType === 'string' && flags2EnvType) {
        return flags2EnvType;
    }

    return JSON.stringify(property.type);
}

function coercionInputFrom(values: Readonly<{[key: string]: unknown}>): {[key: string]: unknown} {
    const result: {[key: string]: unknown} = {};

    for (const key of Object.keys(values)) {
        const value = values[key];
        if (value === '') {
            continue;
        }
        if (typeof value === 'string' && BOOLEAN_ENV_KEYS.has(key)) {
            result[key] = normalizedBooleanCoercionValue(key, value);
        } else if (typeof value === 'string' && INTEGER_ENV_KEYS.has(key)) {
            result[key] = value.trim();
        } else {
            result[key] = value;
        }
    }

    return result;
}

function normalizedBooleanCoercionValue(key: string, value: string): boolean | string {
    const normalized = value.trim().toLowerCase();

    if (['true', 't', '1', 'yes', 'y', 'on'].indexOf(normalized) >= 0) {
        return true;
    }

    if (['false', 'f', '0', 'no', 'n', 'off'].indexOf(normalized) >= 0 ||
        (key === 'lmx_log_errors' && normalized === 'nope')) {
        return false;
    }

    return normalized;
}

function coerceCliConfig(
    values: Readonly<{[key: string]: unknown}>,
    configPath: string
): BrokerCliConfig {
    try {
        return flags2Env.coerce<BrokerCliConfig>(values, {configPath});
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new BrokerRuntimeConfigError(`Could not coerce broker configuration: ${message}`);
    }
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

function validateRuntimeValues(env: BrokerRuntimeValues): void {
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

function brokerConfigFromValues(env: BrokerRuntimeValues): IBrokerOptsPartial {
    const broker: IBrokerOptsPartial = {
        host: readString(firstRuntimeValue(env.live_mutex_host, env.LMX_HOST, env.lmx_host), 'live_mutex_host') ||
            DEFAULT_BROKER_HOST,
        lockExpiresAfter: readInteger(env.live_mutex_lock_expires_after, 'live_mutex_lock_expires_after',
            DEFAULT_LOCK_EXPIRES_AFTER, 21, 3999999),
        noDelay: readBoolean(env.live_mutex_no_delay, 'live_mutex_no_delay', true),
        port: readInteger(firstRuntimeValue(env.live_mutex_port, env.LMX_PORT, env.lmx_port), 'live_mutex_port',
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

function applyBrokerJsonConfig(broker: IBrokerOptsPartial, raw: unknown): void {
    if (!hasRuntimeValue(raw)) {
        return;
    }

    let parsed: unknown = raw;

    if (typeof raw === 'string') {
        try {
            parsed = JSON.parse(raw);
        } catch (err) {
            const e = err as Error;
            throw new BrokerRuntimeConfigError(`LMX_BROKER_CONFIG_JSON could not be parsed as JSON: ${e.message}`);
        }
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

function applyDirectCliBrokerOverrides(broker: IBrokerOptsPartial, cliEnv: BrokerCliConfig): void {
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

function httpConfigFromValues(env: BrokerRuntimeValues): BrokerRuntimeHttpConfig {
    const host = readString(env.LMX_HTTP_HOST, 'LMX_HTTP_HOST') || DEFAULT_HTTP_HOST;
    const maxBodyBytes = readOptionalInteger(env.LMX_HTTP_MAX_BODY_BYTES, 'LMX_HTTP_MAX_BODY_BYTES',
        1, 10 * 1024 * 1024);
    const requestTimeoutMs = readOptionalInteger(env.LMX_HTTP_REQUEST_TIMEOUT_MS, 'LMX_HTTP_REQUEST_TIMEOUT_MS',
        1, 24 * 60 * 60 * 1000);
    const enableHtmlStatus = readBoolean(env.LMX_HTTP_HTML_STATUS, 'LMX_HTTP_HTML_STATUS', true);

    if (!hasRuntimeValue(env.LMX_HTTP_PORT)) {
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

function readString(value: unknown, name: string): string | undefined {
    if (!hasRuntimeValue(value)) {
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
    value: unknown,
    name: string,
    defaultValue: number | undefined,
    min: number,
    max: number
): number {
    if (!hasRuntimeValue(value)) {
        if (defaultValue === undefined) {
            throw new BrokerRuntimeConfigError(`${name} must be set.`);
        }
        return defaultValue;
    }

    return readIntegerValue(value, name, min, max);
}

function readOptionalInteger(value: unknown, name: string, min: number, max: number): number | undefined {
    if (!hasRuntimeValue(value)) {
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

function readBoolean(value: unknown, name: string, defaultValue: boolean): boolean {
    const parsed = readOptionalBoolean(value, name);
    return parsed === undefined ? defaultValue : parsed;
}

function readOptionalBoolean(value: unknown, name: string): boolean | undefined {
    if (!hasRuntimeValue(value)) {
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

function hasEnvValue(value: string | undefined): value is string {
    return value !== undefined && value !== '';
}

function hasRuntimeValue(value: unknown): boolean {
    return value !== undefined && value !== null && value !== '';
}

function hasOwn(obj: object, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(obj, key);
}

function firstRuntimeValue(...values: unknown[]): unknown {
    for (const value of values) {
        if (hasRuntimeValue(value)) {
            return value;
        }
    }

    return undefined;
}

function redactUnknownOption(option: string): string {
    const separator = option.indexOf('=');
    const optionName = separator < 0 ? option : option.slice(0, separator);

    if (/^-[^-].+/.test(optionName)) {
        return optionName.slice(0, 2);
    }

    return optionName;
}
