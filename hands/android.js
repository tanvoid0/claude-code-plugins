#!/usr/bin/env node
// android.js - drive an Android emulator with no window, no desktop, no focus.
//
//   up [avd]            boot headless (-no-window) and wait for sys.boot_completed
//   devices             what adb can see
//   ui                  the screen as a list of labelled, tappable points
//   tap <text|x y>      tap by visible label, or by raw coordinates
//   text <string>       type into whatever has focus
//   key <name>          a keyevent: BACK, HOME, ENTER, TAB, DEL
//   swipe <x1 y1 x2 y2 [ms]>
//   open <action|pkg/act>   am start - an intent or a component
//   install <apk>       install and report the package
//   shot [out.png]      screencap straight off the framebuffer
//   logs [n] [filter]   logcat tail, warnings and above by default
//   down                kill the emulator
//
// `ui` is the point of this file. A screenshot of a phone costs ~1500 tokens and
// cannot be clicked; the same screen as text costs ~150 and every line carries the
// coordinates to tap it. Screenshot only when the question is visual.
const { spawnSync, spawn } = require('child_process');
const fs = require('fs'), path = require('path'), os = require('os');

const SDK = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || 'D:/sdk/android';
const exe = (d, n) => path.join(SDK, d, process.platform === 'win32' ? n + '.exe' : n);
const adb = (...a) => spawnSync(exe('platform-tools', 'adb'), a, { encoding: 'buffer', maxBuffer: 1 << 28 });
const sh = (...a) => adb('shell', ...a).stdout.toString().replace(/\r/g, '');
const sleep = (ms) => spawnSync(process.execPath, ['-e', `setTimeout(()=>{},${ms})`]);
const die = (m) => { console.error(m); process.exit(2); };

// A uiautomator dump written to /sdcard and read back breaks under Git Bash, which
// rewrites a leading /sdcard into a Windows path. /dev/tty streams it over adb instead.
const dumpXml = () => adb('exec-out', 'uiautomator', 'dump', '/dev/tty').stdout.toString();

const unescape_ = (t) => t.replace(/&amp;/g, '&').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

// Flatten the hierarchy to one line per thing worth naming. A node earns a line if it
// carries a label a person would read - its text, its description, or its hint - and
// has a box. A resource id is a fallback label only for something clickable, because an
// id on a layout container names the scaffolding rather than the interface.
//
// The description matters as much as the text: a native icon button has only a
// description, and Flutter puts *everything* there - its nodes come through with
// text="" and the visible string in content-desc, so a rule of "text, or clickable"
// sees a Flutter screen as one button and nothing else.
//
// The same label at the same point appears twice in most dumps - once on the touch
// target, once on the view inside it - so identical points are collapsed.
function parse(xml) {
  const out = [], tappable = new Set();
  for (const m of xml.matchAll(/<node [^>]*>/g)) {
    const g = (k) => (m[0].match(new RegExp(` ${k}="([^"]*)"`)) || [])[1] || '';
    const b = g('bounds').match(/\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/);
    if (!b) continue;
    const click = g('clickable') === 'true';
    const input = /EditText/.test(g('class'));
    const said = g('text') || g('content-desc') || g('hint');
    const label = unescape_(said || (click ? g('resource-id').split('/').pop() : ''));
    const x = (+b[1] + +b[3]) >> 1, y = (+b[2] + +b[4]) >> 1;
    if (click) tappable.add(x + ',' + y);
    if (!label) continue;
    const hit = out.find((o) => o.label === label && o.x === x && o.y === y);
    if (hit) { hit.click = hit.click || click; continue; }  // keep the clickable of the pair
    out.push({ label, x, y, click, input });
  }
  // A Flutter icon button names the wrapper and makes an unnamed child the tap target,
  // so the label and the clickable flag land on different nodes over the same box.
  // Anything sharing a point with something clickable is clickable.
  for (const e of out) if (tappable.has(e.x + ',' + e.y)) e.click = true;
  return out;
}

const ui = () => parse(dumpXml());
const show = (els) => els.map((e) => `${e.click ? '*' : ' '} ${e.label} @${e.x},${e.y}`).join('\n');

function find(els, q) {
  const n = q.toLowerCase();
  return els.find((e) => e.click && e.label.toLowerCase() === n)
      || els.find((e) => e.label.toLowerCase() === n)
      || els.find((e) => e.click && e.label.toLowerCase().includes(n))
      || els.find((e) => e.label.toLowerCase().includes(n));
}

function up(avd) {
  const running = /\bdevice\b/.test(adb('devices').stdout.toString());
  if (!running) {
    const avds = fs.existsSync(path.join(os.homedir(), '.android', 'avd'))
      ? fs.readdirSync(path.join(os.homedir(), '.android', 'avd')).filter((f) => f.endsWith('.ini')).map((f) => f.slice(0, -4))
      : [];
    if (!avd) avd = avds[0];
    if (!avd) die('no AVD found - create one: avdmanager create avd -n <name> -k "system-images;android-35;google_apis;x86_64"');
    if (avds.length && !avds.includes(avd)) die(`no AVD '${avd}' - have: ${avds.join(', ')}`);
    spawn(exe('emulator', 'emulator'),
      ['-avd', avd, '-no-window', '-no-audio', '-no-snapshot', '-no-boot-anim', '-gpu', 'swiftshader_indirect'],
      { detached: true, stdio: 'ignore' }).unref();
  }
  adb('wait-for-device');
  // Booted is not ready: the launcher is still starting and a dump returns the boot
  // screen. sys.boot_completed is the flag that says the device will answer input.
  for (let i = 0; i < 90; i++) {
    if (sh('getprop', 'sys.boot_completed').trim() === '1') {
      sh('input', 'keyevent', 'KEYCODE_WAKEUP');
      sh('wm', 'dismiss-keyguard');
      return console.log(running ? 'already up' : `booted ${avd}`);
    }
    sleep(2000);
  }
  die('emulator did not finish booting in 3 minutes');
}

function selftest() {
  const a = (c, m) => { if (!c) { console.error('FAIL ' + m); process.exitCode = 1; } };

  // A native screen: text on the views, ids on the scaffolding.
  const native = parse(`<hierarchy>
  <node text="" resource-id="x:id/root" class="FrameLayout" clickable="false" bounds="[0,0][1080,2400]" />
  <node text="Network &amp; internet" resource-id="" class="LinearLayout" clickable="true" bounds="[100,600][900,700]" />
  <node text="Network &amp; internet" resource-id="x:id/title" class="TextView" clickable="false" bounds="[100,600][900,700]" />
  <node text="" content-desc="Search" class="ImageButton" clickable="true" bounds="[0,100][200,200]" />
  <node text="" resource-id="x:id/pane" class="FrameLayout" clickable="false" bounds="[0,0][10,10]" /></hierarchy>`);
  a(native.length === 2, `native: dedupe + drop scaffolding, got ${native.length} (${native.map((e) => e.label)})`);
  a(native[0].label === 'Network & internet', 'entity decoded');
  a(native[0].x === 500 && native[0].y === 650, 'centre of bounds');
  a(native[0].click, 'the clickable of a duplicated pair wins');
  a(native[1].label === 'Search', 'content-desc names an icon button');
  a(find(native, 'network').y === 650, 'find by substring, case-insensitive');
  a(find(native, 'nope') === undefined, 'find misses cleanly');

  // A Flutter screen: every label arrives as content-desc, most nodes are not
  // clickable, and an icon button's tap target is an unnamed child of the named node.
  const flutter = parse(`<hierarchy>
  <node text="" content-desc="" class="android.view.View" clickable="false" bounds="[0,0][1080,2424]" />
  <node text="" content-desc="Count is 0" class="android.view.View" clickable="false" bounds="[63,352][351,441]" />
  <node text="" content-desc="Increment" class="android.widget.Button" clickable="true" bounds="[63,483][358,609]" />
  <node text="" content-desc="Reset counter" class="android.widget.Button" clickable="false" bounds="[63,651][189,777]" />
  <node text="" content-desc="" class="android.widget.Button" clickable="true" bounds="[63,651][189,777]" />
  <node text="" content-desc="" class="android.widget.EditText" clickable="true" hint="Your name" bounds="[63,819][1017,966]" /></hierarchy>`);
  a(flutter.length === 4, `flutter: got ${flutter.length} (${flutter.map((e) => e.label)})`);
  a(flutter[0].label === 'Count is 0' && !flutter[0].click, 'flutter text is content-desc on a non-clickable node');
  a(find(flutter, 'reset counter').click, 'label on the wrapper, tap target on the unnamed child');
  a(find(flutter, 'Your name').input, 'an EditText is named by its hint and marked an input');
  a(find(flutter, 'increment').x === 210, 'flutter button centre');

  console.log(process.exitCode ? 'selftest FAILED' : 'selftest ok');
}

const [cmd, ...args] = process.argv.slice(2);
switch (cmd) {
  case 'up': up(args[0]); break;
  case 'devices': console.log(adb('devices').stdout.toString().trim()); break;
  case 'ui': console.log(show(ui())); break;
  case 'tap': {
    let [x, y] = args;
    if (isNaN(+x)) {
      const q = args.join(' '), t = find(ui(), q);
      if (!t) die(`no element matching '${q}' - run: android.js ui`);
      [x, y] = [t.x, t.y];
    }
    sh('input', 'tap', String(x), String(y));
    console.log(`tap ${x},${y}`);
    break;
  }
  case 'text': sh('input', 'text', args.join(' ').replace(/ /g, '%s')); break;
  case 'key': sh('input', 'keyevent', 'KEYCODE_' + String(args[0] || '').toUpperCase()); break;
  case 'swipe': sh('input', 'swipe', ...args.map(String)); break;
  case 'open': {
    const t = args[0] || die('need an intent action or pkg/activity');
    console.log(sh('am', 'start', ...(t.includes('/') ? ['-n', t] : ['-a', t])).trim());
    break;
  }
  case 'install': {
    const apk = args[0] || die('need an apk path');
    console.log(adb('install', '-r', apk).stdout.toString().trim());
    break;
  }
  case 'shot': {
    const f = args[0] || path.join(os.tmpdir(), 'android.png');
    const png = adb('exec-out', 'screencap', '-p').stdout;
    if (!png.length) die('screencap returned nothing - is a device attached?');
    fs.writeFileSync(f, png);
    console.log(f);
    break;
  }
  case 'logs': console.log(sh('logcat', '-d', '-t', String(args[0] || 50), args[1] || '*:W')); break;
  case 'down': adb('emu', 'kill'); console.log('killed'); break;
  case 'selftest': selftest(); break;
  default: console.log('up|devices|ui|tap|text|key|swipe|open|install|shot|logs|down|selftest');
}
