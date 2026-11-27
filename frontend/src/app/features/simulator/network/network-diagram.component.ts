import { Component, computed, input, output } from '@angular/core';
import type { ArchitectureNode } from '../../../core/models/architecture.model';
import type { CanvasNetwork, NetworkFrame } from '../../../core/models/canvas-network.model';

interface DiagramBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

function center(bounds: DiagramBounds) {
  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
}

function edgePoint(bounds: DiagramBounds, dx: number, dy: number) {
  const origin = center(bounds);
  const factor =
    1 / Math.max(Math.abs(dx) / (bounds.width / 2), Math.abs(dy) / (bounds.height / 2));
  return { x: origin.x + dx * factor, y: origin.y + dy * factor };
}

@Component({
  selector: 'app-network-diagram',
  standalone: true,
  template: `
    @for (frame of network().frames; track frame.id) {
      <div
        class="network-frame"
        [attr.data-network-frame-id]="frame.id"
        [attr.data-frame-kind]="frame.kind"
        [style.left.px]="frame.x"
        [style.top.px]="frame.y"
        [style.width.px]="frame.width"
        [style.height.px]="frame.height"
        [class.network-frame--focused]="focusedId() === frame.id"
      >
        <button
          type="button"
          class="frame-title"
          [title]="frame.name"
          (pointerdown)="$event.stopPropagation()"
          (click)="$event.stopPropagation(); frameSelected.emit(frame)"
        >
          <span class="frame-kind">{{
            frame.kind === 'subnet' ? 'Subnet' : frame.kind.toUpperCase()
          }}</span>
          <span class="frame-name">{{ frame.name }}</span>
        </button>
      </div>
    }
    @if (links().length) {
      <svg
        class="network-links"
        role="img"
        aria-label="Diagram links. Dashed lines do not carry simulated traffic."
      >
        <defs>
          <marker
            id="network-arrowhead"
            markerWidth="6"
            markerHeight="6"
            refX="5"
            refY="3"
            orient="auto"
          >
            <path d="M0 0 L6 3 L0 6 Z" class="network-arrowhead" />
          </marker>
        </defs>
        @for (link of links(); track link.id) {
          <g
            [attr.data-network-arrow-id]="link.id"
            [class.network-link--focused]="focusedId() === link.id"
          >
            <line
              [attr.x1]="link.start.x"
              [attr.y1]="link.start.y"
              [attr.x2]="link.end.x"
              [attr.y2]="link.end.y"
              marker-end="url(#network-arrowhead)"
              class="network-link"
            />
            @if (link.label) {
              <text
                [attr.x]="link.x"
                [attr.y]="link.y - 8"
                text-anchor="middle"
                class="network-link-label"
              >
                {{ link.label }}
              </text>
            }
          </g>
        }
      </svg>
    }
  `,
  styleUrl: './network-diagram.component.css',
})
export class NetworkDiagramComponent {
  readonly network = input.required<CanvasNetwork>();
  readonly nodes = input.required<ArchitectureNode[]>();
  readonly focusedId = input<string | undefined>();
  readonly frameSelected = output<NetworkFrame>();

  protected readonly links = computed(() => {
    const network = this.network();
    if (!network.arrows.length) return [];
    const bounds = new Map<string, DiagramBounds>(network.frames.map((frame) => [frame.id, frame]));
    for (const node of this.nodes()) {
      bounds.set(node.id, { x: node.x, y: node.y, width: 148, height: 94 });
    }
    return network.arrows.flatMap((link) => {
      const source = bounds.get(link.sourceId);
      const target = bounds.get(link.targetId);
      if (!source || !target) return [];
      const from = center(source);
      const to = center(target);
      const dx = to.x - from.x || (to.y === from.y ? 1 : 0);
      const dy = to.y - from.y;
      const start = edgePoint(source, dx, dy);
      const end = edgePoint(target, -dx, -dy);
      return [{ ...link, start, end, x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }];
    });
  });
}
