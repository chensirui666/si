import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

export type DirectoryPicker = (signal: AbortSignal) => Promise<string | null>

// NSOpenPanel handles normal file navigation. The Edit menu enables paste in Go to Folder.
const panel = `
ObjC.import('AppKit');
function run() {
  var app = $.NSApplication.sharedApplication;
  app.setActivationPolicy($.NSApplicationActivationPolicyAccessory);
  var menu = $.NSMenu.alloc.init;
  menu.addItem($.NSMenuItem.alloc.init);
  var edit = $.NSMenu.alloc.initWithTitle('Edit');
  var editItem = $.NSMenuItem.alloc.init;
  editItem.submenu = edit;
  menu.addItem(editItem);
  edit.addItemWithTitleActionKeyEquivalent('Cut', 'cut:', 'x');
  edit.addItemWithTitleActionKeyEquivalent('Copy', 'copy:', 'c');
  edit.addItemWithTitleActionKeyEquivalent('Paste', 'paste:', 'v');
  edit.addItemWithTitleActionKeyEquivalent('Select All', 'selectAll:', 'a');
  app.mainMenu = menu;
  app.activateIgnoringOtherApps(true);
  var panel = $.NSOpenPanel.openPanel;
  panel.message = '选择工作区文件夹';
  panel.canChooseFiles = false;
  panel.canChooseDirectories = true;
  panel.allowsMultipleSelection = false;
  if (panel.runModal !== $.NSModalResponseOK) return 'null';
  var urls = panel.URLs;
  if (urls.count < 1) return 'null';
  return JSON.stringify(ObjC.unwrap(urls.objectAtIndex(0).path));
}
`

export const pickDirectory: DirectoryPicker = async signal => {
  if (process.platform !== 'darwin') throw new Error('当前系统不支持原生工作区选择。')
  try {
    const { stdout } = await promisify(execFile)('/usr/bin/osascript', ['-l', 'JavaScript', '-e', panel], { signal })
    const selected: unknown = JSON.parse(stdout)
    if (selected === null || typeof selected === 'string') return selected
    throw new Error('选择框返回了无效路径。')
  } catch {
    throw new Error('无法打开 macOS 工作区选择框。')
  }
}
