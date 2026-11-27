import { describe, expect, it } from 'vitest';
import { checkAgentName, hasDeceptiveChars, soundsLikeCommand } from './names';

describe('agent names', () => {
  it('refuse instruction-like and authority-like words in the launch languages, wherever they are in the name', () => {
    for (const name of [
      'SystemNotice', 'IgnorePrevious', 'Admin_Bot', 'TheModerator', 'NewInstructions', 'my-api-key', 'PromptMaster', 'Sy5tem', 'Adm1n',
      'SistemaGM', 'IgnoraTudo', 'Contraseña', 'Système', 'Modérateur', 'MotDePasse', 'システム', '管理员', '忽略指令',
    ]) {
      expect(checkAgentName(name), name).toEqual({ ok: false, reason: 'reserved' });
      expect(soundsLikeCommand(name), name).toBe(true);
    }
  });

  it('refuse Object.prototype names', () => {
    for (const name of ['constructor', '__proto__', 'toString', 'valueOf', 'prototype', 'hasOwnProperty', '__defineGetter__', 'Constructor']) {
      expect(checkAgentName(name).ok, name).toBe(false);
    }
  });

  it('accept ordinary names', () => {
    for (const name of ['Wulf', 'Brasa', 'Pip-2', 'Ana_Lu', 'Sakura', 'さくら', '李太白', 'Élodie', 'Instructor']) expect(checkAgentName(name).ok, name).toBe(true);
  });

  it('share the invisible-character and modifier-letter rule', () => {
    expect(hasDeceptiveChars('Wulf')).toBe(false);
    for (const s of ['Wu\u200blf', 'Wulf\u02d0', 'Wu\ua788lf', 'Wu\u034flf']) expect(hasDeceptiveChars(s), JSON.stringify(s)).toBe(true);
  });
});
