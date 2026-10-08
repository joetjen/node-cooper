'use strict';

/**
 * @fileoverview The loaded-value model: every CASC value maps to a native
 * JS value or one of these classes. See the README's value table for the
 * full mapping, and each class's own doc for why it exists.
 */

const Secret = require('./secret.cjs');
const Tuple = require('./tuple.cjs');
const Duration = require('./duration.cjs');
const ByteSize = require('./byte-size.cjs');
const LocalDate = require('./local-date.cjs');
const LocalTime = require('./local-time.cjs');
const LocalDateTime = require('./local-date-time.cjs');
const DateTime = require('./date-time.cjs');
const CooperFloat = require('./cooper-float.cjs');
const IPv4 = require('./ipv4.cjs');
const IPv6 = require('./ipv6.cjs');
const ModuleRef = require('./module-ref.cjs');

module.exports = { Secret, Tuple, Duration, ByteSize, LocalDate, LocalTime, LocalDateTime, DateTime, CooperFloat, IPv4, IPv6, ModuleRef };
