import { describe, expect, it } from 'vitest';
import { applyCommand, createEmptyDoc, type Command } from '@smartcity/shared';
import { crossDoc } from '../test/fixtures';
import { chunkCommands, exportDoc, parseImport } from './importExport';

describe('import/export', () => {
  it('chunks by count and size', () => {
    const cmds: Command[] = Array.from({ length: 2500 }, (_, i) => ({ type: 'node.add', node: { id: `n${i}`, pos: { x: i % 100, z: Math.floor(i / 100) } } }));
    const byCount = chunkCommands(cmds, 1000);
    expect(byCount).toHaveLength(3);
    expect(byCount.every((b) => b.type === 'batch' && b.commands.length <= 1000)).toBe(true);
    const bySize = chunkCommands(cmds, 1000, 5000);
    expect(bySize.length).toBeGreaterThan(3);
    for (const b of bySize) expect(JSON.stringify(b).length).toBeLessThan(5200);
  });

  it('round-trips an exported city into an empty doc', () => {
    const { doc } = crossDoc();
    const parsed = parseImport(exportDoc(doc));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const fresh = createEmptyDoc();
    for (const c of parsed.commands) expect(applyCommand(fresh, c).ok).toBe(true);
    expect(Object.keys(fresh.segments).sort()).toEqual(Object.keys(doc.segments).sort());
  });

  it('rejects garbage', () => {
    expect(parseImport('not json').ok).toBe(false);
    expect(parseImport('{"version":2}').ok).toBe(false);
  });
});
