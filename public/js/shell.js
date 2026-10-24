// mongosh syntax <-> canonical EJSON, both ways.
//
// toShell prints the canonical EJSON the server sends (C3) the way mongosh would:
// ObjectId("…"), ISODate("…"), NumberLong("…"), plain numbers for Int32/Double.
// fromShell evaluates what people type or paste (unquoted keys, single quotes, the
// helpers above, /re/i, trailing commas) back into EJSON-shaped plain values.
// Int32 vs Double survives the trip through text: toShell prints every double with
// a '.' or exponent (1.0, 1e+21), and fromShell reads such literals as doubles.
// Plain script so the browser gets window.MangoShell and node tests can require() it.
(function (root) {
  'use strict';

  /* ================= EJSON -> shell text ================= */

  const IDENT = /^[A-Za-z_$][\w$]*$/;
  const q = (s) => JSON.stringify(String(s));

  function keyText(k) {
    if (k === '__proto__') return '["__proto__"]'; // a literal key would set the prototype
    return IDENT.test(k) ? k : JSON.stringify(k);
  }

  function hexOf(b64) {
    try {
      return Array.from(atob(b64), (c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
    } catch { return null; }
  }

  // Literal /re/ only when JS reads it back unchanged; PCRE-only syntax or options
  // (x, l) keep the explicit constructor, which mongosh also understands.
  function regexText(pattern, options) {
    try {
      if (/^[imsu]*$/.test(options) && new RegExp(pattern, options).source === pattern) {
        return '/' + pattern + '/' + options;
      }
    } catch { /* not a JS regex */ }
    return 'BSONRegExp(' + q(pattern) + ', ' + q(options) + ')';
  }

  function doubleText(s) {
    s = String(s);
    return /^-?\d+$/.test(s) ? s + '.0' : s; // keep it a double when read back
  }

  // The shell form of a single EJSON wrapper, or null if v is a plain document.
  function wrapperText(v, keys, ind, depth) {
    const has = (...ks) => keys.length === ks.length && ks.every((k) => keys.includes(k));
    const x = v[keys[0]];
    if (has('$oid')) return 'ObjectId(' + q(x) + ')';
    if (has('$numberInt')) return String(x);
    if (has('$numberDouble')) return doubleText(x);
    if (has('$numberLong')) return 'NumberLong(' + q(x) + ')';
    if (has('$numberDecimal')) return 'NumberDecimal(' + q(x) + ')';
    if (has('$date')) {
      const ms = x !== null && typeof x === 'object' ? Number(x.$numberLong) : x;
      const d = new Date(typeof ms === 'string' && !/^-?\d+$/.test(ms) ? ms : Number(ms));
      if (!isNaN(d.getTime())) return 'ISODate(' + q(d.toISOString()) + ')';
      return null; // out of JS Date range — the generic printer keeps it exact
    }
    if (has('$binary') && x && typeof x === 'object') {
      const hex = x.subType === '04' ? hexOf(x.base64) : null;
      if (hex && hex.length === 32) {
        return 'UUID(' + q(hex.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5')) + ')';
      }
      return 'BinData(' + parseInt(x.subType, 16) + ', ' + q(x.base64) + ')';
    }
    if (has('$uuid')) return 'UUID(' + q(x) + ')';
    if (has('$timestamp') && x && typeof x === 'object') return 'Timestamp({ t: ' + x.t + ', i: ' + x.i + ' })';
    if (has('$regularExpression') && x && typeof x === 'object') return regexText(x.pattern, x.options || '');
    if ((has('$regex') || has('$regex', '$options')) && typeof v.$regex === 'string'
      && typeof (v.$options || '') === 'string') return regexText(v.$regex, v.$options || '');
    if (has('$minKey')) return 'MinKey()';
    if (has('$maxKey')) return 'MaxKey()';
    if (has('$code')) return 'Code(' + q(x) + ')';
    if (has('$code', '$scope')) return 'Code(' + q(v.$code) + ', ' + print(v.$scope, ind, depth) + ')';
    if ((has('$ref', '$id') || has('$ref', '$id', '$db')) && typeof v.$ref === 'string') {
      return 'DBRef(' + q(v.$ref) + ', ' + print(v.$id, ind, depth)
        + (v.$db !== undefined ? ', ' + q(v.$db) : '') + ')';
    }
    return null;
  }

  function print(v, ind, depth) {
    if (v === undefined) return 'undefined';
    if (v === null) return 'null';
    if (typeof v === 'string') return JSON.stringify(v);
    if (typeof v === 'number') return Number.isInteger(v) && Math.abs(v) < 1e21 ? String(v) : doubleText(v);
    if (typeof v === 'boolean') return String(v);
    if (typeof v !== 'object') return JSON.stringify(v) || 'undefined';
    let items, open, close;
    if (Array.isArray(v)) {
      if (!v.length) return '[]';
      items = v.map((x) => print(x, ind, depth + 1));
      [open, close] = ['[', ']'];
    } else {
      const keys = Object.keys(v);
      if (!keys.length) return '{}';
      const w = wrapperText(v, keys, ind, depth);
      if (w !== null) return w;
      items = keys.map((k) => keyText(k) + ': ' + print(v[k], ind, depth + 1));
      [open, close] = ['{ ', ' }'];
    }
    const inline = open + items.join(', ') + close;
    // nested values that fit on a line stay on it, like mongosh prints them
    if (!ind || (depth > 0 && !inline.includes('\n') && inline.length + depth * ind.length <= 72)) return inline;
    const pad = '\n' + ind.repeat(depth + 1);
    return open.trim() + pad + items.join(',' + pad) + '\n' + ind.repeat(depth) + close.trim();
  }

  // indent: spaces (number) or an indent string; falsy prints on one line.
  function toShell(value, indent) {
    const ind = typeof indent === 'number' ? ' '.repeat(Math.min(10, indent)) : (indent || '');
    return print(value, ind, 0);
  }

  /* ================= shell text -> EJSON-shaped value ================= */

  // A double that still does arithmetic (valueOf) and string-converts to the literal
  // as typed (toString, so NumberDecimal(1.10) keeps "1.10"); JSON sees only the wrapper.
  const DOUBLE = {
    valueOf() { return Number(this.$numberDouble); },
    toString() { return this.$numberDouble; },
  };
  const dbl = (text) => Object.create(DOUBLE, { $numberDouble: { value: String(text), enumerable: true } });
  const isDbl = (v) => v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === DOUBLE;
  const intText = (v) => (isDbl(v) ? String(Number(v)) : String(v));

  let oidCounter = Math.floor(Math.random() * 0x1000000);
  const oidRandom = Array.from({ length: 5 }, () =>
    Math.floor(Math.random() * 256).toString(16).padStart(2, '0')).join('');
  function newObjectId() {
    oidCounter = (oidCounter + 1) % 0x1000000;
    return Math.floor(Date.now() / 1000).toString(16).padStart(8, '0') + oidRandom
      + oidCounter.toString(16).padStart(6, '0');
  }

  // function expressions, not arrows or methods: `new Date(…)` / `new ObjectId(…)` must work too.
  const SHELL = {
    ObjectId: function (v) { return { $oid: v === undefined ? newObjectId() : String(v) }; },
    ISODate: function (...a) {
      if (!a.length) return new Date();
      if (a.length > 1) return new Date(...a.map(Number)); // new Date(y, m, d…): local time, as in JS
      let v = a[0];
      // mongosh reads a zone-less date-time ("T" or " ") as UTC; JS would read it as local time
      if (typeof v === 'string' && /^\d{4}-\d\d-\d\d[T ]\d\d:\d\d(:\d\d(\.\d+)?)?$/.test(v)) v = v.replace(' ', 'T') + 'Z';
      return new Date(isDbl(v) ? Number(v) : v);
    },
    NumberLong: function (v) { return { $numberLong: intText(v) }; },
    NumberInt: function (v) { return { $numberInt: intText(v) }; },
    NumberDouble: function (v) { return dbl(v); },
    NumberDecimal: function (v) { return { $numberDecimal: String(v) }; },
    UUID: function (v) {
      if (v === undefined && typeof crypto !== 'undefined' && crypto.randomUUID) v = crypto.randomUUID();
      return { $uuid: String(v) };
    },
    BinData: function (t, v) { return { $binary: { base64: String(v), subType: Number(t).toString(16).padStart(2, '0') } }; },
    Timestamp: function (t, i) {
      if (t !== null && typeof t === 'object') ({ t, i } = t);
      return { $timestamp: { t: Number(t), i: Number(i) } };
    },
    MinKey: function () { return { $minKey: 1 }; },
    MaxKey: function () { return { $maxKey: 1 }; },
    BSONRegExp: function (p, o) { return { $regularExpression: { pattern: String(p), options: String(o || '') } }; },
    Code: function (c, scope) { return scope ? { $code: String(c), $scope: scope } : { $code: String(c) }; },
    DBRef: function (ref, id, db) { return db === undefined ? { $ref: ref, $id: id } : { $ref: ref, $id: id, $db: db }; },
  };
  SHELL.ISODate.now = Date.now;
  Object.assign(SHELL, {
    ObjectID: SHELL.ObjectId, Date: SHELL.ISODate,
    Double: SHELL.NumberDouble, Int32: SHELL.NumberInt, Decimal128: SHELL.NumberDecimal,
  });
  const NAMES = Object.keys(SHELL);

  // Free identifiers must not resolve to the page's globals (window.closed, name,
  // element ids…): `{status: closed}` is a ReferenceError, as in mongosh, not false.
  const BUILTINS = new Set([...NAMES, 'undefined', 'NaN', 'Infinity', 'Math', 'Number', 'String',
    'Boolean', 'BigInt', 'Symbol', 'JSON', 'RegExp', 'Array', 'Object',
    'parseInt', 'parseFloat', 'isNaN', 'isFinite']);
  const SCOPE = new Proxy(Object.create(null), {
    has: (t, k) => typeof k === 'string' && !BUILTINS.has(k),
    get: (t, k) => {
      if (typeof k !== 'string') return undefined; // Symbol.unscopables
      throw new ReferenceError(k + ' is not defined');
    },
  });

  const NUM = /(?:0[xXoObB][\da-fA-F_]+n?|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?n?)/y;
  const WORD = /[A-Za-z_$][\w$]*/y;
  const REGEX_BEFORE = '(,=:[!&|?{};+-*%<>~^'; // a '/' after one of these starts a regex
  const UNARY_BEFORE = '(,:['; // a '-' after one of these is a sign

  const isDoubleLit = (lit) => !/^0[xXoObB]/.test(lit) && !lit.endsWith('n') && /[.eE]/.test(lit);
  const matchAt = (re, s, i) => { re.lastIndex = i; const m = re.exec(s); return m && m[0]; };

  // Rewrite double literals (1.0, -2.5e3, Infinity, NaN) to NumberDouble("…") so the
  // type survives evaluation, and literal "__proto__" keys to computed ones so they
  // stay own properties. Strings, comments and regex literals are copied untouched.
  function rewrite(src) {
    let out = '';
    let prev = ''; // last significant character
    let i = 0;
    const n = src.length;
    const keyAhead = (j) => { while (j < n && /\s/.test(src[j])) j++; return src[j] === ':'; };
    while (i < n) {
      const c = src[i];
      let tok;
      if (/\s/.test(c)) { out += c; i++; continue; }
      if (c === '/' && (src[i + 1] === '/' || src[i + 1] === '*')) {
        const line = src[i + 1] === '/';
        const j = line ? src.indexOf('\n', i) : src.indexOf('*/', i + 2);
        const e = j < 0 ? n : (line ? j : j + 2);
        out += src.slice(i, e);
        i = e;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') {
        let j = i + 1;
        while (j < n && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
        tok = src.slice(i, j + 1);
        i = j + 1;
        out += tok.slice(1, -1) === '__proto__' && keyAhead(i) ? '[' + tok + ']' : tok;
        prev = '"';
        continue;
      }
      if (c === '/' && (!prev || REGEX_BEFORE.includes(prev))) {
        let j = i + 1;
        let inClass = false;
        while (j < n && src[j] !== '\n' && (inClass || src[j] !== '/')) {
          if (src[j] === '\\') j++;
          else if (src[j] === '[') inClass = true;
          else if (src[j] === ']') inClass = false;
          j++;
        }
        j++;
        while (j < n && /\w/.test(src[j])) j++;
        out += src.slice(i, j);
        i = j;
        prev = '/';
        continue;
      }
      if ((tok = matchAt(WORD, src, i))) {
        i += tok.length;
        const key = keyAhead(i);
        if ((tok === 'Infinity' || tok === 'NaN') && !key && prev !== '.') out += 'NumberDouble("' + tok + '")';
        else out += tok === '__proto__' && key ? '["__proto__"]' : tok;
        prev = 'a';
        continue;
      }
      const signed = c === '-' && (!prev || UNARY_BEFORE.includes(prev));
      const at = signed ? i + 1 : i;
      if ((tok = matchAt(NUM, src, at)) || (signed && (tok = matchAt(WORD, src, at)) === 'Infinity')) {
        const lit = src.slice(i, at + tok.length);
        i = at + tok.length;
        const isDouble = tok === 'Infinity' || isDoubleLit(tok);
        out += isDouble && !keyAhead(i) ? 'NumberDouble("' + lit.replace(/_/g, '') + '")' : lit;
        prev = '0';
        continue;
      }
      out += c;
      prev = c;
      i++;
    }
    return out;
  }

  // Date/RegExp have to be read off the holder: their own toJSON runs first.
  function replacer(k, v) {
    const raw = this[k];
    if (raw instanceof RegExp) return { $regularExpression: { pattern: raw.source, options: raw.flags } };
    if (raw instanceof Date) {
      const ms = raw.getTime();
      if (isNaN(ms)) throw new Error('Invalid date');
      return { $date: { $numberLong: String(ms) } };
    }
    if (typeof v === 'bigint') return { $numberLong: String(v) };
    return v;
  }

  // Shell / JSON text -> EJSON-shaped plain value. Throws with the evaluator's message.
  function fromShell(text) {
    const src = rewrite(String(text));
    let value;
    try {
      // eslint-disable-next-line no-new-func -- the user's own expression, in their own tab
      // `with` (sloppy outer function) routes lookups through SCOPE; the expression itself is strict
      value = new Function('__scope', ...NAMES,
        'with (__scope) return (function () { "use strict"; return (' + src + '\n); })();')(
        SCOPE, ...NAMES.map((k) => SHELL[k]));
    } catch (e) {
      throw new Error(e.message); // drop the SyntaxError/ReferenceError prefix noise
    }
    const json = JSON.stringify(value, replacer);
    if (json === undefined) throw new Error('Not a value');
    return JSON.parse(json);
  }

  const api = { toShell, fromShell };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MangoShell = api;
})(typeof window !== 'undefined' ? window : globalThis);
