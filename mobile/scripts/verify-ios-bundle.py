#!/usr/bin/env python3
"""Verify a locally built/exported .app against this checkout before installation.

--distribution additionally rejects development/ad-hoc provisioning. This does
not approve privacy answers, App Review content, or an App Store submission.
"""
import argparse
import hashlib
import json
import plistlib
import re
import subprocess
from pathlib import Path


def verify(app, distribution=False):
    root = Path(__file__).resolve().parents[2]
    version = json.loads((root / 'mobile/package.json').read_text())['version']
    major, minor, patch = map(int, version.split('.'))
    build = str(major * 10000 + minor * 100 + patch)
    run = lambda args: subprocess.check_output(args, stderr=subprocess.PIPE)
    info = plistlib.loads((app / 'Info.plist').read_bytes())
    assert info['CFBundleIdentifier'] == 'com.crowelogic.mobile', 'Wrong app bundle'
    assert info['CFBundleShortVersionString'] == version, 'Stale app version'
    assert info['CFBundleVersion'] == build, 'Stale app build number'
    assert int(re.search(r'iphoneos(\d+)', info['DTSDKName'])[1]) >= 26, 'iOS SDK is below the submission minimum'
    scene = info['UIApplicationSceneManifest']
    assert scene['UIApplicationSupportsMultipleScenes'] is False
    config = scene['UISceneConfigurations']['UIWindowSceneSessionRoleApplication'][0]
    assert config['UISceneDelegateClassName'].endswith('.SceneDelegate')
    assert not config.get('UISceneStoryboardFile'), 'A second storyboard bridge would be created'
    assert 'UIMainStoryboardFile' not in info, 'Legacy window creation is still configured'
    config = json.loads((app / 'capacitor.config.json').read_text())
    assert config['appId'] == info['CFBundleIdentifier']
    assert not config.get('server', {}).get('url'), 'Live-reload URL must not ship'
    extension = app / 'PlugIns/CroweShare.appex'
    ext = plistlib.loads((extension / 'Info.plist').read_bytes())
    assert ext['CFBundleVersion'] == build and ext['CFBundleShortVersionString'] == version, 'Share extension is stale'
    for bundle in [app, extension]:
        run(['codesign', '--verify', '--deep', '--strict', str(bundle)])
        privacy = plistlib.loads((bundle / 'PrivacyInfo.xcprivacy').read_bytes())
        assert privacy['NSPrivacyTracking'] is False
    assets = []
    sources = ['mobile/src/phone-mirror.js', 'mobile/src/phone-mirror.css',
               'mobile/src/crowe-keyboard.js', 'mobile/src/native-chrome.js',
               'mobile/src/mobile-bridge.js', 'renderer/look.css', 'renderer/theme-bootstrap.js']
    for source in sources:
        original = (root / source).read_bytes()
        bundled = app / 'public' / Path(source).name
        assert original == bundled.read_bytes(), f'Bundled source is stale: {source}'
        assets.append({'source': source, 'sha256': hashlib.sha256(original).hexdigest()})
    if distribution:
        for bundle in [app, extension]:
            profile = plistlib.loads(run(['security', 'cms', '-D', '-i', str(bundle / 'embedded.mobileprovision')]))
            assert not profile.get('ProvisionedDevices'), 'Device-limited provisioning cannot be submitted to the store'
            assert not profile.get('ProvisionsAllDevices'), 'Enterprise provisioning cannot be submitted to the store'
            assert profile['Entitlements'].get('get-task-allow') is False, 'Development entitlement cannot ship'
    return {'bundle_id': info['CFBundleIdentifier'], 'version': version, 'build': build,
            'sdk': info['DTSDKName'], 'scene_lifecycle': True, 'codesign_verified': True,
            'distribution_checked': distribution, 'assets': assets}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('app', type=Path)
    parser.add_argument('--distribution', action='store_true')
    args = parser.parse_args()
    try:
        print(json.dumps(verify(args.app, args.distribution), indent=2))
    except (AssertionError, KeyError, ValueError, OSError, subprocess.CalledProcessError) as error:
        # Never include subprocess output, provisioning contents or credentials.
        raise SystemExit(f'iOS bundle verification failed: {type(error).__name__}: {str(error) if not isinstance(error, subprocess.CalledProcessError) else "native verification command failed"}')
