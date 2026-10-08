import { createRequire } from 'node:module';
import version from './version.js';
import CooperError from './error.js';
import {
  Secret, Tuple, Duration, ByteSize, LocalDate, LocalTime, LocalDateTime, DateTime, CooperFloat, IPv4, IPv6, ModuleRef,
} from './values/index.js';

const require = createRequire(import.meta.url);
const cooper = require('./cooper.cjs');

/** @type {typeof cooper.loadFile} */
const loadFile = cooper.loadFile;
/** @type {typeof cooper.loadFileSync} */
const loadFileSync = cooper.loadFileSync;
/** @type {typeof cooper.loadString} */
const loadString = cooper.loadString;
/** @type {typeof cooper.loadStringSync} */
const loadStringSync = cooper.loadStringSync;
/** @type {typeof cooper.Cache} */
const Cache = cooper.Cache;
/** @type {typeof cooper.Dotenv} */
const Dotenv = cooper.Dotenv;

export {
  version,
  loadFile,
  loadFileSync,
  loadString,
  loadStringSync,
  CooperError,
  Cache,
  Dotenv,
  Secret,
  Tuple,
  Duration,
  ByteSize,
  LocalDate,
  LocalTime,
  LocalDateTime,
  DateTime,
  CooperFloat,
  IPv4,
  IPv6,
  ModuleRef,
};

export default {
  version,
  loadFile,
  loadFileSync,
  loadString,
  loadStringSync,
  CooperError,
  Cache,
  Dotenv,
  Secret,
  Tuple,
  Duration,
  ByteSize,
  LocalDate,
  LocalTime,
  LocalDateTime,
  DateTime,
  CooperFloat,
  IPv4,
  IPv6,
  ModuleRef,
};
