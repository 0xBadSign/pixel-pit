// Screen registry for the hash router. Screen agents replace the stub modules; the paths are fixed by SPEC §6.4.
import type { ScreenRegistry, ScreenMount } from '../router';
import { mount as play } from './play';
import { mount as timeline } from './timeline';
import { mount as board } from './board';
import { mount as how } from './how';
import { mount as overlay } from './overlay';

export const screens: ScreenRegistry = {
  '/': play,
  '/timeline': timeline,
  '/board': board,
  '/how': how,
  '/overlay': overlay,
};

export const notFound: ScreenMount = (root) => {
  const p = document.createElement('p');
  p.className = 'muted';
  p.textContent = 'No such page. Routes: #/ #/timeline #/board #/how';
  root.append(p);
};
