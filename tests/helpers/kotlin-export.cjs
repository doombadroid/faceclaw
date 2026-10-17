const fs = require('node:fs');

// The JavaScript names NativeScript gives Kotlin/Native's ObjC export: the function name,
// then each parameter name capitalized (fun f(a, b) -> fA:b: -> fAB); constructors are
// initWith + parameters. Derived from the Kotlin sources so a renamed parameter fails here,
// not on the phone.
exports.exportedNames = function exportedNames(...files) {
  const names = new Set();
  const cap = s => s[0].toUpperCase() + s.slice(1);
  const params = list => list.split(',').map(p => p.trim()).filter(Boolean).map(p => p.split(':')[0].trim().split(/\s+/).pop());
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    for (const [, name, list] of source.matchAll(/^\s*(?:override )?fun (\w+)\(([^)]*)\)/gm)) names.add(name + params(list).map(cap).join(''));
    for (const [, list] of source.matchAll(/^(?:open )?class \w+\(([^)]*)\)/gm)) names.add('initWith' + params(list).map(cap).join(''));
    // Public secondary constructors (an internal primary one is not exported).
    for (const [, list] of source.matchAll(/^\s*constructor\(([^)]*)\)/gm)) names.add('initWith' + params(list).map(cap).join(''));
  }
  return names;
};
