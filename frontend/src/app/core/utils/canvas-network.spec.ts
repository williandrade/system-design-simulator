import { describe, expect, it } from 'vitest';
import { makeNode } from '../testing/fixtures';
import type { CanvasNetwork, NetworkFrame } from '../models/canvas-network.model';
import {
  editCanvasNetwork,
  emptyCanvasNetwork,
  pruneCanvasNetworkNodes,
  validateCanvasNetwork,
} from './canvas-network';

const vpc: NetworkFrame = {
  id: 'vpc',
  kind: 'vpc',
  name: 'Prod',
  x: 10,
  y: 10,
  width: 560,
  height: 380,
};
const az: NetworkFrame = {
  id: 'az',
  kind: 'az',
  name: 'AZ A',
  x: 40,
  y: 55,
  width: 460,
  height: 280,
  parentId: vpc.id,
};
const subnet: NetworkFrame = {
  id: 'subnet',
  kind: 'subnet',
  name: 'Public',
  x: 65,
  y: 105,
  width: 360,
  height: 180,
  parentId: az.id,
};
const app = { ...makeNode('app', 'ecs'), x: 90, y: 145 };
const remote: NetworkFrame = { ...vpc, id: 'remote', name: 'Remote VPC', x: 800 };

function fixture(): CanvasNetwork {
  return {
    frames: [vpc, az, subnet, remote],
    arrows: [
      { id: 'peering', sourceId: vpc.id, targetId: remote.id, label: 'Peering' },
      { id: 'diagram-link', sourceId: az.id, targetId: app.id },
    ],
    nodeParents: { [app.id]: subnet.id },
  };
}

describe('diagram network', () => {
  it('moves nested frames and services together while preserving arrow binding IDs', () => {
    const original = fixture();
    const moved = editCanvasNetwork(
      original,
      [app],
      {
        type: 'update_frame',
        args: { frameId: vpc.id, x: 105, y: 50 },
      },
      () => 'unused',
    );

    expect(moved.network.frames.map(({ x, y }) => [x, y])).toEqual([
      [105, 50],
      [135, 95],
      [160, 145],
      [800, 10],
    ]);
    expect(moved.nodes[0]).toMatchObject({ id: app.id, x: 185, y: 185 });
    expect(moved.network.arrows).toEqual(original.arrows);
    expect(original.frames[0]).toEqual(vpc);
    expect(app).toMatchObject({ x: 90, y: 145 });
  });

  it('removes frame links and reparents surviving children in place', () => {
    const result = editCanvasNetwork(
      fixture(),
      [app],
      {
        type: 'delete_frame',
        args: { frameId: az.id },
      },
      () => 'unused',
    );

    expect(result.nodes).toEqual([app]);
    expect(result.network.frames).toEqual([vpc, { ...subnet, parentId: vpc.id }, remote]);
    expect(result.network.arrows.map((arrow) => arrow.id)).toEqual(['peering']);
    expect(result.network.nodeParents).toEqual({ [app.id]: subnet.id });
  });

  it('removes a deleted service from frame membership and visual links', () => {
    const result = pruneCanvasNetworkNodes(fixture(), [app.id]);
    expect(result.nodeParents).toEqual({});
    expect(result.arrows.map((arrow) => arrow.id)).toEqual(['peering']);
    expect(validateCanvasNetwork(result, [])).toEqual(result);
  });

  it('accepts legacy projects and rejects missing references, invalid parents and duplicates', () => {
    expect(validateCanvasNetwork(undefined, [])).toEqual(emptyCanvasNetwork());
    expect(validateCanvasNetwork(fixture(), [app])).toEqual(fixture());
    expect(() => validateCanvasNetwork(fixture(), [])).toThrow('two different existing');
    expect(() =>
      validateCanvasNetwork(
        { ...fixture(), frames: [{ ...vpc, parentId: subnet.id }, az, subnet, remote] },
        [app],
      ),
    ).toThrow('Invalid parent');
    expect(() => validateCanvasNetwork({ ...fixture(), frames: [vpc, vpc] }, [app])).toThrow(
      'Duplicate diagram ID',
    );
    expect(() =>
      editCanvasNetwork(
        fixture(),
        [app],
        {
          type: 'add_arrow',
          args: { sourceId: vpc.id, targetId: remote.id },
        },
        () => 'new-link',
      ),
    ).toThrow('already exists');
  });

  it('imports only recognized diagram fields so strict MCP outputs accept the saved graph', () => {
    const original = fixture();
    expect(
      validateCanvasNetwork(
        {
          frames: original.frames.map((frame) => ({ ...frame, foreignField: 'ignored' })),
          arrows: original.arrows.map((arrow) => ({ ...arrow, foreignField: 'ignored' })),
          nodeParents: original.nodeParents,
        },
        [app],
      ),
    ).toStrictEqual(original);
  });
});
