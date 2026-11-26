import { Component, computed, signal } from '@angular/core';

type McpClient = 'codex' | 'claude';

interface McpSetup {
  launcherPath: string;
  commands: Record<McpClient, string>;
}

interface DesktopMcpSetup {
  get(): Promise<McpSetup | null>;
  copy(client: McpClient): Promise<boolean>;
}

declare global {
  interface Window {
    simulatorMcpSetup?: DesktopMcpSetup;
  }
}

@Component({
  selector: 'app-mcp-setup',
  templateUrl: './mcp-setup.component.html',
  styleUrl: './mcp-setup.component.css',
})
export class McpSetupComponent {
  private readonly desktop = typeof window === 'undefined' ? undefined : window.simulatorMcpSetup;
  protected readonly setup = signal<McpSetup | null | undefined>(undefined);
  protected readonly client = signal<McpClient>('codex');
  protected readonly serverName = 'willis-overengineer-inator';
  protected readonly copying = signal(false);
  protected readonly copyResult = signal<{ client: McpClient; message: string } | null>(null);
  protected readonly claudeChatConfig = computed(() => {
    const setup = this.setup();
    if (!setup) return '';
    return JSON.stringify(
      {
        mcpServers: {
          [this.serverName]: { command: setup.launcherPath, args: [] },
        },
      },
      null,
      2,
    );
  });

  protected async open(dialog: HTMLDialogElement): Promise<void> {
    this.copyResult.set(null);
    this.setup.set(undefined);
    dialog.showModal();

    try {
      this.setup.set((await this.desktop?.get()) ?? null);
    } catch {
      this.setup.set(null);
    }
  }

  protected async copyCommand(): Promise<void> {
    if (this.copying()) return;
    const client = this.client();
    this.copyResult.set(null);
    this.copying.set(true);

    let copied = false;
    try {
      copied = (await this.desktop?.copy(client)) ?? false;
    } catch {
      // The command remains selectable when the system clipboard is unavailable.
    } finally {
      this.copying.set(false);
    }

    this.copyResult.set({
      client,
      message: copied ? 'Command copied.' : 'Could not copy the command. Select and copy it below.',
    });
  }
}
