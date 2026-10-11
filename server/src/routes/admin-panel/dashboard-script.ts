import { adminPanelCoreScript } from './dashboard-core-script.js'
import { adminPanelDashboardShellScript } from './dashboard-shell-script.js'
import {
  adminPanelConfirmationScript,
  adminPanelDirtyStateScript,
  adminPanelInteractionScript,
} from './dashboard-interactions-script.js'
import { adminPanelNavigationBindingsScript } from './dashboard-navigation-bindings-script.js'
import { adminPanelOtaBindingsScript } from './dashboard-ota-bindings-script.js'
import { adminPanelOtaActionsScript, adminPanelOtaRenderScript } from './dashboard-ota-script.js'
import { adminPanelProviderBindingsScript } from './dashboard-provider-bindings-script.js'
import { adminPanelProviderScript } from './dashboard-provider-script.js'
import { adminPanelQuotaScript } from './dashboard-quota-script.js'
import { adminPanelSceneBindingsScript } from './dashboard-scene-bindings-script.js'
import { adminPanelSceneScript } from './dashboard-scene-script.js'
import { adminPanelUsageBindingsScript } from './dashboard-usage-bindings-script.js'
import { adminPanelUsageNavigationScript, adminPanelUsageScript } from './dashboard-usage-script.js'
import { adminPanelUserBindingsScript } from './dashboard-user-bindings-script.js'
import { adminPanelUsersScript } from './dashboard-users-script.js'

export function adminPanelDashboardScript(input: {
  nonce: string
  providerPresets: string
}): string {
  return `<script nonce="${input.nonce}">
${adminPanelCoreScript({ providerPresets: input.providerPresets })}

${adminPanelProviderScript()}

${adminPanelUsersScript()}

${adminPanelUsageScript()}

${adminPanelSceneScript()}

${adminPanelDirtyStateScript()}

${adminPanelOtaRenderScript()}

${adminPanelInteractionScript()}

${adminPanelOtaActionsScript()}

${adminPanelConfirmationScript()}

${adminPanelQuotaScript()}

${adminPanelUsageNavigationScript()}

${adminPanelNavigationBindingsScript()}

${adminPanelUsageBindingsScript()}

${adminPanelOtaBindingsScript()}

${adminPanelProviderBindingsScript()}

${adminPanelSceneBindingsScript()}

${adminPanelUserBindingsScript()}

${adminPanelDashboardShellScript()}
  </script>`
}
