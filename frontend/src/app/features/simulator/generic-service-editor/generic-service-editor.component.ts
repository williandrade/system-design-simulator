import {
  afterNextRender,
  Component,
  computed,
  ElementRef,
  inject,
  Injector,
  input,
  output,
  viewChildren,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import type {
  GenericServiceMetadata,
  GenericServiceProperty,
} from '../../../core/models/architecture.model';

const EMPTY_PROPERTY: GenericServiceProperty = { key: '', value: '' };

export interface GenericServiceMetadataChange {
  metadata: GenericServiceMetadata;
  editKey?: string;
}

@Component({
  selector: 'app-generic-service-editor',
  imports: [FormsModule],
  host: {
    '(keydown.backspace)': '$event.stopPropagation()',
    '(keydown.delete)': '$event.stopPropagation()',
  },
  templateUrl: './generic-service-editor.component.html',
  styleUrl: './generic-service-editor.component.css',
})
export class GenericServiceEditorComponent {
  readonly metadata = input<GenericServiceMetadata>();
  readonly disabled = input(false);
  readonly metadataChange = output<GenericServiceMetadataChange>();

  private readonly injector = inject(Injector);
  private readonly keyInputs = viewChildren<ElementRef<HTMLInputElement>>('propertyKey');

  protected readonly label = computed(() => this.metadata()?.label ?? '');
  protected readonly properties = computed(() => this.metadata()?.properties ?? []);
  protected readonly visibleProperties = computed(() => {
    const properties = this.properties();
    return properties.length ? properties : [EMPTY_PROPERTY];
  });

  protected updateLabel(label: string): void {
    this.metadataChange.emit({
      metadata: { label, properties: this.properties() },
      editKey: 'label',
    });
  }

  protected updateProperty(index: number, field: keyof GenericServiceProperty, text: string): void {
    const properties = this.visibleProperties().map((property, propertyIndex) =>
      propertyIndex === index ? { ...property, [field]: text } : property,
    );
    this.updateProperties(properties, `property:${index}:${field}`);
  }

  protected addProperty(): void {
    const properties = this.visibleProperties();
    this.updateProperties([...properties, { ...EMPTY_PROPERTY }]);
    this.focusKeyAfterRender(properties.length);
  }

  protected removeProperty(index: number): void {
    const properties = this.properties().filter((_, propertyIndex) => propertyIndex !== index);
    this.updateProperties(properties);
    this.focusKeyAfterRender(Math.max(0, Math.min(index, properties.length - 1)));
  }

  private updateProperties(properties: GenericServiceProperty[], editKey?: string): void {
    this.metadataChange.emit({ metadata: { label: this.label(), properties }, editKey });
  }

  private focusKeyAfterRender(index: number): void {
    afterNextRender(
      { write: () => this.keyInputs()[index]?.nativeElement.focus() },
      {
        injector: this.injector,
      },
    );
  }
}
