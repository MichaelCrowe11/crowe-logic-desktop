"""Malformed SDK metadata must produce a controlled device-bundle refusal."""
import json
import plistlib
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class SDKMetadataTests(unittest.TestCase):
    def test_non_device_or_missing_sdk_is_refused_without_traceback(self):
        version = json.loads((ROOT / 'mobile/package.json').read_text())['version']
        major, minor, patch = map(int, version.split('.'))
        for sdk in [None, '', 'iphonesimulator26.2', 'iphoneos25.0', 'invalid']:
            with self.subTest(sdk=sdk), tempfile.TemporaryDirectory(prefix='crowe-ios-metadata-') as tmp:
                app = Path(tmp) / 'App.app'
                app.mkdir()
                info = {'CFBundleIdentifier': 'com.crowelogic.mobile',
                        'CFBundleShortVersionString': version,
                        'CFBundleVersion': str(major * 10000 + minor * 100 + patch)}
                if sdk is not None:
                    info['DTSDKName'] = sdk
                (app / 'Info.plist').write_bytes(plistlib.dumps(info))
                result = subprocess.run([sys.executable, str(ROOT / 'mobile/scripts/verify-ios-bundle.py'), str(app)], capture_output=True, text=True)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('iOS bundle verification failed', result.stderr)
                self.assertNotIn('Traceback', result.stderr)


if __name__ == '__main__':
    unittest.main()
