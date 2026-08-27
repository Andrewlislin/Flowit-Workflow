import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
source = ROOT / 'tests/contracts/opencode-client.test.ts'
destination = ROOT / 'packages/adapter-opencode/tests/opencode-client.test.ts'
destination.parent.mkdir(parents=True, exist_ok=True)
source.rename(destination)
text = destination.read_text().replace(
    "from '../../src/adapters/opencode.js'",
    "from '../src/index.js'",
)
destination.write_text(text)

package_path = ROOT / 'package.json'
package = json.loads(package_path.read_text())
package['scripts']['test:opencode-contract'] = (
    'node --import tsx --test packages/adapter-opencode/tests/opencode-client.test.ts'
)
package_path.write_text(json.dumps(package, indent=2) + '\n')

ci = ROOT / '.github/workflows/ci.yml'
ci.write_text(
    ci.read_text().replace(
        'run: node --import tsx --test tests/contracts/opencode-client.test.ts',
        'run: pnpm test:opencode-contract',
    )
)
print('OpenCode contract test moved into the adapter package boundary.')
