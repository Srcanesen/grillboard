// Loads one pure <script id="..."> block of viewer.html and returns the global it defines.
// Node has no document and no window, so a block that touches the page fails here.
import { readFileSync } from 'node:fs';

const viewer = new URL('../../skills/grillboard/viewer.html', import.meta.url);

export function loadBlock(id, globalName) {
  const html = readFileSync(viewer, 'utf8');
  const match = new RegExp('<script id="' + id + '">([\\s\\S]*?)</script>').exec(html);
  if (!match) throw new Error('viewer.html has no <script id="' + id + '"> block');
  return new Function(match[1] + '\nreturn ' + globalName + ';')();
}
