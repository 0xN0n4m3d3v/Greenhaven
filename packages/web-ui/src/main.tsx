import React from 'react'
import {createRoot} from 'react-dom/client'

// Greenhaven type system: EB Garamond for narrative/display, Inter for UI
// chrome, system pills, and tabular numbers. No Google Fonts CDN call.
import '@fontsource/eb-garamond/400.css';
import '@fontsource/eb-garamond/400-italic.css';
import '@fontsource/eb-garamond/600.css';
import '@fontsource/inter/400.css';
import '@fontsource/inter/400-italic.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';

import './style.css'
import './App.css'
import './styles/messenger.css'
import './styles/messenger-layout.css'
import './styles/tg-bubbles.css'
import './styles/cartridge-library.css'
import './styles/greenhaven-skin.css'
import './styles/greenhaven-square-system.css'
import {WizardGate} from './WizardGate'
import {TranslationProvider} from './i18n'
import {BootGate} from './BootGate'
import {initFrontendTelemetry} from './lib/frontendTelemetry'
import {installVolumeSetterGuard} from './lib/audioVolume'
import {TooltipProvider} from './components/ui/tooltip'

const container = document.getElementById('root')

const root = createRoot(container!)

// Defensive: wrap HTMLMediaElement.volume's setter so any third-party
// fade loop (Howler, future widgets) cannot push a float-drift
// negative through to the renderer. Idempotent + DOM-only.
installVolumeSetterGuard()

initFrontendTelemetry()

root.render(
    <React.StrictMode>
        <TooltipProvider delayDuration={200}>
            <BootGate>
                <TranslationProvider>
                    <WizardGate/>
                </TranslationProvider>
            </BootGate>
        </TooltipProvider>
    </React.StrictMode>
)
