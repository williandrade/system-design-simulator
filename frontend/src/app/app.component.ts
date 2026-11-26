import { Component, OnDestroy, OnInit, inject } from '@angular/core';
import { SimulatorComponent } from './features/simulator/simulator.component';
import { DocumentationComponent } from './features/documentation/documentation.component';
import { ReportsComponent } from './features/reports/reports.component';
import { ThemeService } from './core/services/theme.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [SimulatorComponent, DocumentationComponent, ReportsComponent],
  template: `
    @if (reportsOpen) {
      <app-reports />
    } @else if (docsOpen) {
      <app-documentation />
    } @else {
      <app-simulator />
    }
  `,
})
export class AppComponent implements OnInit, OnDestroy {
  private readonly themeService = inject(ThemeService);

  docsOpen = false;
  reportsOpen = false;

  private readonly onPop = () => {
    this.handleRouting();
  };

  ngOnInit(): void {
    this.handleRouting();
    window.addEventListener('popstate', this.onPop);
  }

  ngOnDestroy(): void {
    window.removeEventListener('popstate', this.onPop);
  }

  private handleRouting(): void {
    if (typeof window !== 'undefined' && window.location) {
      const url = new URL(window.location.href);
      const [, section] = url.pathname.split('/');
      this.reportsOpen = section === 'benchmarks' || section === 'reports';
      this.docsOpen = section === 'docs';
      if (!this.reportsOpen && !this.docsOpen && url.pathname !== '/playground' && url.pathname !== '/') {
        url.pathname = '/';
        window.history.replaceState(window.history.state, '', url);
      }
    }
  }
}
