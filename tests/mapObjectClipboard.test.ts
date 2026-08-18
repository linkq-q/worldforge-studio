import { describe, expect, it } from 'vitest';
import { createEmptyMap, createMapObject } from '../src/shared/map';
import { copyMapObjectSubtree, pasteMapObjectSubtree } from '../src/client/mapObjectClipboard';

describe('map object clipboard', () => {
  it('copies a complete subtree with new IDs and one root offset', () => {
    const map = createEmptyMap('clipboard', 'clipboard-map');
    const table = createMapObject('Table', 'table-asset');
    table.transform.position = [2, 0, 3];
    const cup = createMapObject('Cup', 'cup-asset');
    cup.parentId = table.id;
    cup.transform.position = [0.2, 0.8, 0];
    map.objects.push(table, cup);

    const clipboard = copyMapObjectSubtree(map, table.id)!;
    const pasted = pasteMapObjectSubtree(map, clipboard);

    expect(pasted.objects).toHaveLength(2);
    expect(pasted.objects[0].id).not.toBe(table.id);
    expect(pasted.objects[0].transform.position).toEqual([2.5, 0, 3.5]);
    expect(pasted.objects[1].parentId).toBe(pasted.objects[0].id);
    expect(pasted.objects[1].transform.position).toEqual(cup.transform.position);
  });

  it('drops unavailable external parents and room-opening bindings across maps', () => {
    const source = createEmptyMap('source', 'source-map');
    const parent = createMapObject('Building');
    const door = createMapObject('Door', 'door-asset');
    door.parentId = parent.id;
    door.roomOpeningId = 'opening-a';
    source.objects.push(parent, door);
    const clipboard = copyMapObjectSubtree(source, door.id)!;

    const pasted = pasteMapObjectSubtree(createEmptyMap('target', 'target-map'), clipboard);

    expect(pasted.objects[0].parentId).toBeNull();
    expect(pasted.objects[0].roomOpeningId).toBeUndefined();
  });
});
