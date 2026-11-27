import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ProjectStorageService, PersistedWorkspace } from './project-storage.service';
import { ArchitectureProject } from '../models/architecture.model';
import { makeConn, makeNode } from '../testing/fixtures';
import { hasValidGenericServiceMetadata } from '../utils/generic-service-metadata';
import type { CanvasNetwork } from '../models/canvas-network.model';

class MemoryStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  clear(): void {
    this.store.clear();
  }
}

const project: ArchitectureProject = {
  id: 'p1',
  name: 'My Design',
  nodes: [],
  connections: [],
  annotations: [],
  currency: 'USD',
  region: 'us-east-1',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const workspace: PersistedWorkspace = {
  activeIndex: 1,
  tabs: [
    {
      id: 't1', name: 'Tab 1', projectName: 'My Design',
      nodes: [], connections: [], annotations: [], currency: 'USD', region: 'us-east-1',
    },
  ],
};

const generic = makeNode('billing', 'generic');
const network: CanvasNetwork = {
  frames: [{ id: 'vpc', kind: 'vpc', name: 'Prod', x: 0, y: 0, width: 300, height: 200 }],
  arrows: [],
  nodeParents: { [generic.id]: 'vpc' },
};
const genericWithMetadata = {
  ...generic,
  genericMetadata: {
    label: 'Partner API',
    properties: [
      { key: 'owner', value: 'Payments' },
      { key: 'owner', value: '' },
      { key: '', value: '' },
    ],
  },
};

describe('ProjectStorageService', () => {
  let service: ProjectStorageService;

  beforeEach(() => {
    (globalThis as { localStorage?: unknown }).localStorage = new MemoryStorage();
    service = new ProjectStorageService();
  });

  afterEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  describe('project', () => {
    it('round-trips a saved project through loadLocal', () => {
      service.save(project);
      expect(service.loadLocal()).toEqual(project);
    });

    it('keeps ordered generic rows, duplicate keys, and incomplete edits in a saved project', () => {
      const withGeneric = { ...project, nodes: [genericWithMetadata, generic] };
      service.save(withGeneric);
      expect(service.loadLocal()).toEqual(withGeneric);
    });

    it('uses default generic metadata when the saved single project contains malformed metadata', () => {
      const storedProject = {
        ...project,
        nodes: [{ ...generic, genericMetadata: null }],
      };
      localStorage.setItem('aws-system-design-simulator-project', JSON.stringify(storedProject));
      expect(service.loadLocal()).toEqual({ ...project, nodes: [generic] });
    });

    it('returns null when no project is stored', () => {
      expect(service.loadLocal()).toBeNull();
    });

    it('recovers a project with corrupt optional network data', () => {
      const stored = { ...project, nodes: [generic], network: { ...network, frames: null } };
      localStorage.setItem('aws-system-design-simulator-project', JSON.stringify(stored));
      expect(service.loadLocal()).toEqual({ ...project, nodes: [generic] });
    });

    it('returns null (does not throw) when the stored project JSON is corrupt', () => {
      localStorage.setItem('aws-system-design-simulator-project', '{truncated');
      expect(service.loadLocal()).toBeNull();
    });

    it('emits the saved project from the returned observable', () => {
      let emitted: ArchitectureProject | undefined;
      service.save(project).subscribe((p) => (emitted = p));
      expect(emitted).toEqual(project);
    });
  });

  describe('workspace', () => {
    it('round-trips a saved workspace through loadWorkspace', () => {
      service.saveWorkspace(workspace);
      expect(service.loadWorkspace()).toEqual(workspace);
    });

    it('restores populated tabs alongside an older empty tab without nodes', () => {
      const emptyTab = { ...workspace.tabs[0], nodes: undefined };
      const populatedTab = { ...workspace.tabs[0], id: 't2', nodes: [genericWithMetadata] };
      localStorage.setItem(
        'aws-system-design-simulator-workspace',
        JSON.stringify({ ...workspace, tabs: [emptyTab, populatedTab] }),
      );

      expect(service.loadWorkspace()).toEqual({
        ...workspace,
        tabs: [workspace.tabs[0], populatedTab],
      });
    });

    it('recovers a damaged generic node while preserving other nodes, edges, and tabs', () => {
      const damaged = makeNode('damaged', 'generic');
      const users = makeNode('users', 'client');
      const tab = {
        ...workspace.tabs[0],
        nodes: [users, genericWithMetadata, damaged],
        connections: [makeConn(users.id, damaged.id)],
      };
      const cleanTab = { ...workspace.tabs[0], id: 't2' };
      const storedWorkspace = {
        ...workspace,
        tabs: [
          {
            ...tab,
            nodes: [
              users,
              genericWithMetadata,
              { ...damaged, genericMetadata: { label: 'Invalid', properties: [{ key: 'owner', value: 1 }] } },
            ],
          },
          cleanTab,
        ],
      };
      localStorage.setItem('aws-system-design-simulator-workspace', JSON.stringify(storedWorkspace));
      expect(service.loadWorkspace()).toEqual({ ...workspace, tabs: [tab, cleanTab] });
    });

    it('returns null when no workspace is stored', () => {
      expect(service.loadWorkspace()).toBeNull();
    });

    it('recovers a corrupt tab network while preserving a healthy network in another tab', () => {
      const cleanTab = { ...workspace.tabs[0], id: 't2', nodes: [generic], network };
      const invalidTab = { ...workspace.tabs[0], network };
      localStorage.setItem('aws-system-design-simulator-workspace', JSON.stringify({
        ...workspace, tabs: [invalidTab, cleanTab],
      }));
      expect(service.loadWorkspace()).toEqual({ ...workspace, tabs: [workspace.tabs[0], cleanTab] });
    });

    it('returns null (does not throw) when the stored workspace JSON is corrupt', () => {
      localStorage.setItem('aws-system-design-simulator-workspace', '{not valid json');
      expect(service.loadWorkspace()).toBeNull();
    });

    it('clearWorkspace removes the workspace but leaves the project intact', () => {
      service.save(project);
      service.saveWorkspace(workspace);
      service.clearWorkspace();
      expect(service.loadWorkspace()).toBeNull();
      expect(service.loadLocal()).toEqual(project);
    });
  });
});

describe('generic service metadata import validation', () => {
  it('accepts absent metadata, ordered editable rows, and existing AWS nodes', () => {
    expect(hasValidGenericServiceMetadata(generic)).toBe(true);
    expect(hasValidGenericServiceMetadata(genericWithMetadata)).toBe(true);
    expect(hasValidGenericServiceMetadata(makeNode('users', 'client'))).toBe(true);
  });

  it.each([
    null,
    { label: false, properties: [] },
    { label: '', properties: { owner: 'Payments' } },
    { label: '', properties: [null] },
    { label: '', properties: [{ key: 'owner', value: 1 }] },
  ])('rejects malformed metadata (%j)', (genericMetadata) => {
    expect(hasValidGenericServiceMetadata({ ...generic, genericMetadata })).toBe(false);
  });
});
