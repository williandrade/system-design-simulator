import { Injectable } from '@angular/core';
import { Observable, of } from 'rxjs';
import {
  ArchitectureProject,
  ArchitectureNode,
  ArchitectureConnection,
  Annotation,
  Currency,
} from '../models/architecture.model';
import { recoverGenericServiceMetadata } from '../utils/generic-service-metadata';
import { validateCanvasNetwork } from '../utils/canvas-network';
import type { CanvasNetwork } from '../models/canvas-network.model';

const storageKey = 'aws-system-design-simulator-project';
const workspaceKey = 'aws-system-design-simulator-workspace';

export interface PersistedTab {
  id: string;
  name: string;
  projectName: string;
  nodes: ArchitectureNode[];
  connections: ArchitectureConnection[];
  annotations: Annotation[];
  network?: CanvasNetwork;
  currency: Currency;
  region: string;
}

export interface PersistedWorkspace {
  activeIndex: number;
  tabs: PersistedTab[];
}

function recoverCanvas<T extends { nodes: ArchitectureNode[]; network?: CanvasNetwork }>(stored: T): T {
  const { nodes: savedNodes, network } = stored;
  const nodes = recoverGenericServiceMetadata(savedNodes ?? []);
  if (network === undefined) return { ...stored, nodes };
  try {
    return { ...stored, nodes, network: validateCanvasNetwork(network, nodes) };
  } catch {
    // Old or damaged optional diagram metadata must not hide otherwise readable canvases.
    return { ...stored, nodes, network: undefined };
  }
}

@Injectable({ providedIn: 'root' })
export class ProjectStorageService {
  constructor() {}

  save(project: ArchitectureProject): Observable<ArchitectureProject> {
    localStorage.setItem(storageKey, JSON.stringify(project));
    return of(project);
  }

  loadLocal(): ArchitectureProject | null {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return null;
    try {
      const project = JSON.parse(raw) as ArchitectureProject;
      return recoverCanvas(project);
    } catch {
      return null;
    }
  }

  saveWorkspace(workspace: PersistedWorkspace): void {
    localStorage.setItem(workspaceKey, JSON.stringify(workspace));
  }

  loadWorkspace(): PersistedWorkspace | null {
    const raw = localStorage.getItem(workspaceKey);
    if (!raw) return null;
    try {
      const workspace = JSON.parse(raw) as PersistedWorkspace;
      return {
        ...workspace,
        tabs: workspace.tabs.map(recoverCanvas),
      };
    } catch {
      return null;
    }
  }

  clearWorkspace(): void {
    localStorage.removeItem(workspaceKey);
  }
}
