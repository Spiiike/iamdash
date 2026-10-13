import json, sys
t = json.load(open(sys.argv[1]))
declared = set(t.get('parameters', {}))
problems = []

def calls_outside_literals(expr):
    """Yield parameter names passed to parameters('...') calls ARM will execute."""
    i, n, in_lit = 0, len(expr), False
    while i < n:
        c = expr[i]
        if in_lit:
            if c == "'":
                if i + 1 < n and expr[i + 1] == "'": i += 2; continue
                in_lit = False
            i += 1; continue
        if c == "'": in_lit = True; i += 1; continue
        if expr.startswith("parameters('", i):
            j = i + len("parameters('"); k = expr.index("'", j)
            yield expr[j:k]; i = k + 1; continue
        i += 1

def walk(node, path, in_variables):
    if isinstance(node, dict) and 'copy' in node and isinstance(node['copy'], list):
        for c in node['copy']:
            if '[[' in json.dumps(c.get('input', '')) or "'[" in json.dumps(c.get('input', '')):
                problems.append(f"policy expression inside a property loop (ARM re-evaluates loop output): {path}.copy[{c.get('name')}]")
    if isinstance(node, dict):
        for k, v in node.items(): walk(v, f"{path}.{k}", in_variables)
    elif isinstance(node, list):
        for i, v in enumerate(node): walk(v, f"{path}[{i}]", in_variables)
    elif isinstance(node, str):
        if node.startswith('[['):
            if in_variables:
                problems.append(f"escaped expression stored in a variable (double-evaluation risk): {path} = {node[:60]}")
            return  # literal for the policy engine; ARM does not execute it
        if node.startswith('[') and node.endswith(']'):
            if "'[" in node:
                problems.append(f"policy expression passed as a literal inside an ARM expression (ARM may evaluate it again): {path}")
            for name in calls_outside_literals(node[1:-1]):
                if name not in declared:
                    problems.append(f"ARM would resolve parameters('{name}') but no such template parameter: {path}")

def check_template(tpl, path):
    global declared
    saved = declared
    declared = set(tpl.get('parameters', {}))
    walk(tpl.get('variables', {}), f'{path}.variables', True)
    res = tpl.get('resources', {})
    items = res.items() if isinstance(res, dict) else enumerate(res)
    for k, r in items:
        inner = (r.get('properties') or {}).get('template') if isinstance(r, dict) else None
        if inner:
            # A nested deployment: its template has its own parameters.
            outer = {kk: vv for kk, vv in r.items() if kk != 'properties'}
            outer_props = {kk: vv for kk, vv in r['properties'].items() if kk != 'template'}
            walk(outer, f'{path}.resources[{k}]', False)
            walk(outer_props, f'{path}.resources[{k}].properties', False)
            check_template(inner, f'{path}.resources[{k}].template')
        else:
            walk(r, f'{path}.resources[{k}]', False)
    walk(tpl.get('outputs', {}), f'{path}.outputs', False)
    declared = saved

KNOWN_ROLES = {
    'acdd72a7-3385-48ef-bd42-f606fba81ae7': 'Reader',
    '8e3af657-a8ff-443c-a75c-2fe8c4bcb635': 'Owner',
    'b24988ac-6180-42a0-ab88-20f7382dd24c': 'Contributor',
}
import re
for guid in set(re.findall(r"roleDefinitions', '([0-9a-f-]{36})'|roleDefinitions/([0-9a-f-]{36})", json.dumps(t))):
    g = guid[0] or guid[1]
    if g not in KNOWN_ROLES:
        problems.append(f"role definition id {g} is not a known built-in role; verify with: az role definition list --query \"[?name=='{g}'].roleName\"")
for vname, v in (t.get('variables') or {}).items():
    if 'role' in vname.lower() and isinstance(v, str) and re.fullmatch(r'[0-9a-f-]{36}', v) and v not in KNOWN_ROLES:
        problems.append(f"variable {vname} = {v} is not a known built-in role id")
check_template(t, 'root')
print('root template parameters:', sorted(set(t.get('parameters', {}))))
print('PROBLEMS:' if problems else 'no problems found')
for p in problems: print('  -', p)
sys.exit(1 if problems else 0)
