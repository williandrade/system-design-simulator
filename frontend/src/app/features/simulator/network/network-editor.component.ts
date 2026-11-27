import {
  Component,
  ElementRef,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  output,
  untracked,
} from '@angular/core';
import { FormsModule, NgForm } from '@angular/forms';
import type { ArchitectureNode } from '../../../core/models/architecture.model';
import type {
  CanvasNetwork,
  NetworkFrame,
  NetworkFrameKind,
} from '../../../core/models/canvas-network.model';
import type { NetworkOperation } from '../../../core/utils/canvas-network';

@Component({
  selector: 'app-network-editor',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './network-editor.component.html',
  styleUrl: './network-editor.component.css',
})
export class NetworkEditorComponent {
  readonly network = input.required<CanvasNetwork>();
  readonly nodes = input.required<ArchitectureNode[]>();
  readonly origin = input.required<{ x: number; y: number }>();
  readonly frameToEdit = input<NetworkFrame>();
  readonly disabled = input(false);
  readonly feedback = input<{ message: string; error: boolean }>();
  readonly operation = output<NetworkOperation>();
  readonly closed = output();

  protected section: 'frames' | 'links' | 'membership' = 'frames';
  protected frameId = '';
  protected frameKind: NetworkFrameKind = 'vpc';
  protected frameName = '';
  protected frameParent = '';
  protected frameX = 0;
  protected frameY = 0;
  protected frameWidth = 560;
  protected frameHeight = 380;
  private savedFrame = '';

  protected arrowId = '';
  protected arrowSource = '';
  protected arrowTarget = '';
  protected arrowLabel = '';

  protected nodeId = '';
  protected nodeParent = '';

  protected readonly endpoints = computed(() => [
    ...this.network().frames.map(({ id, name }) => ({ id, name: `${name} (frame)` })),
    ...this.nodes().map(({ id, name }) => ({ id, name })),
  ]);

  constructor() {
    const host = inject<ElementRef<HTMLElement>>(ElementRef);
    afterNextRender(() =>
      host.nativeElement.querySelector<HTMLElement>('[data-network-initial-focus]')?.focus(),
    );
    effect(() => {
      const frame = this.frameToEdit();
      untracked(() => {
        if (frame || !this.frameId) this.selectFrame(frame?.id ?? '');
      });
    });
    effect(() => {
      const network = this.network();
      untracked(() => {
        const selectedFrame = network.frames.find((frame) => frame.id === this.frameId);
        if (this.frameId && JSON.stringify(selectedFrame) !== this.savedFrame)
          this.selectFrame(selectedFrame?.id ?? '');
        if (this.arrowId) this.selectArrow(this.arrowId);
        if (this.nodeId) this.selectService(this.nodeId);
      });
    });
  }

  protected parentsForFrame(): NetworkFrame[] {
    if (this.frameKind === 'vpc') return [];
    return this.network().frames.filter(
      (frame) =>
        frame.id !== this.frameId &&
        (this.frameKind === 'subnet' ? frame.kind !== 'subnet' : frame.kind === 'vpc'),
    );
  }

  protected selectFrame(frameId: string): void {
    this.section = 'frames';
    this.frameId = frameId;
    const frame = this.network().frames.find((item) => item.id === frameId);
    this.savedFrame = JSON.stringify(frame) ?? '';
    if (frame) {
      this.frameKind = frame.kind;
      this.frameName = frame.name;
      this.frameParent = frame.parentId ?? '';
      this.frameX = frame.x;
      this.frameY = frame.y;
      this.frameWidth = frame.width;
      this.frameHeight = frame.height;
      return;
    }
    this.frameId = '';
    this.frameName = '';
    this.frameParent = '';
    this.setNewFrameKind('vpc');
  }

  protected setNewFrameKind(kind: NetworkFrameKind): void {
    this.frameKind = kind;
    this.frameParent = '';
    const sizes = { vpc: [560, 380], az: [480, 290], subnet: [360, 210] };
    [this.frameWidth, this.frameHeight] = sizes[kind];
    this.frameX = this.origin().x;
    this.frameY = this.origin().y;
  }

  protected chooseFrameParent(parentId: string): void {
    this.frameParent = parentId;
    const parent = this.network().frames.find((frame) => frame.id === parentId);
    if (!parent || this.frameId) return;
    this.frameX = parent.x + 24;
    this.frameY = parent.y + 48;
    this.frameWidth = Math.min(this.frameWidth, Math.max(1, parent.width - 48));
    this.frameHeight = Math.min(this.frameHeight, Math.max(1, parent.height - 72));
  }

  protected saveFrame(form: NgForm): void {
    const name = this.frameName.trim();
    if (this.disabled() || form.invalid || !name) return;
    const { frameX: x, frameY: y, frameWidth: width, frameHeight: height } = this;
    const frame = { name, x, y, width, height };
    this.operation.emit(
      this.frameId
        ? {
            type: 'update_frame',
            args: { ...frame, frameId: this.frameId, parentId: this.frameParent || null },
          }
        : {
            type: 'add_frame',
            args: { ...frame, kind: this.frameKind, parentId: this.frameParent || undefined },
          },
    );
  }

  protected deleteFrame(): void {
    if (this.disabled() || !this.frameId) return;
    this.operation.emit({ type: 'delete_frame', args: { frameId: this.frameId } });
  }

  protected selectArrow(arrowId: string): void {
    const arrow = this.network().arrows.find((item) => item.id === arrowId);
    this.arrowId = arrow?.id ?? '';
    this.arrowSource = arrow?.sourceId ?? '';
    this.arrowTarget = arrow?.targetId ?? '';
    this.arrowLabel = arrow?.label ?? '';
  }

  protected endpointName(id: string): string {
    return this.endpoints().find((endpoint) => endpoint.id === id)?.name ?? id;
  }

  protected saveArrow(form: NgForm): void {
    if (this.disabled() || form.invalid || !this.arrowSource || !this.arrowTarget) return;
    const args = {
      sourceId: this.arrowSource,
      targetId: this.arrowTarget,
      label: this.arrowLabel.trim(),
    };
    this.operation.emit(
      this.arrowId
        ? { type: 'update_arrow', args: { ...args, arrowId: this.arrowId } }
        : { type: 'add_arrow', args },
    );
  }

  protected deleteArrow(): void {
    if (this.disabled() || !this.arrowId) return;
    this.operation.emit({ type: 'delete_arrow', args: { arrowId: this.arrowId } });
  }

  protected selectService(nodeId: string): void {
    this.nodeId = this.nodes().some((node) => node.id === nodeId) ? nodeId : '';
    const memberships = this.network().nodeParents;
    this.nodeParent = Object.hasOwn(memberships, nodeId) ? memberships[nodeId] : '';
  }

  protected saveMembership(): void {
    if (this.disabled() || !this.nodeId) return;
    this.operation.emit({
      type: 'assign_parent',
      args: { nodeId: this.nodeId, parentId: this.nodeParent || null },
    });
  }
}
