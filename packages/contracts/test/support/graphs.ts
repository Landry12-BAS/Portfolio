// Graphs the tests start from: a valid workflow, and a way to change a copy of it.
import type { WorkflowGraph } from '../../src/index.ts'

/** The workflow the LB-08 datasheet describes: a big wholesale order is checked, announced and confirmed. */
export const wholesaleGraph: WorkflowGraph = {
  name: 'Wholesale order over 500 euros',
  nodes: [
    { id: 'order_received', type: 'trigger', label: 'Wholesale order arrives', event: 'wholesale_order' },
    { id: 'big_order', type: 'condition', label: 'Order over 500 euros?', field: 'trigger.totalEur', op: 'gt', value: 500 },
    { id: 'check_stock', type: 'action', label: 'Check stock', connector: 'stock_check', params: { sku: '{{trigger.sku}}', quantityKg: '{{trigger.quantityKg}}' } },
    {
      id: 'alert_roastery',
      type: 'action',
      label: 'Alert the roastery',
      connector: 'slack_alert',
      params: { channel: '#roastery', message: 'Order {{trigger.orderId}} from {{trigger.cafe}}: {{trigger.quantityKg}} kg of {{check_stock.productName}}' },
    },
    {
      id: 'email_cafe',
      type: 'action',
      label: 'Email the cafe',
      connector: 'email',
      params: { to: 'customer', subject: 'Your order {{trigger.orderId}}', body: 'Thank you. It should arrive in {{check_stock.etaDays}} days.' },
    },
  ],
  edges: [
    { from: 'order_received', to: 'big_order' },
    { from: 'big_order', to: 'check_stock', branch: 'true' },
    { from: 'check_stock', to: 'alert_roastery' },
    { from: 'check_stock', to: 'email_cafe' },
  ],
}

/** Returns a deep copy of a graph as plain data, so a test can break it in one place. */
export function copyOf(graph: WorkflowGraph = wholesaleGraph): Record<string, unknown> {
  return structuredClone(graph) as unknown as Record<string, unknown>
}

/** Makes an email step, for tests that need more steps. */
export function emailNode(id: string, to = 'roastery'): Record<string, unknown> {
  return { id, type: 'action', label: `Email ${id}`, connector: 'email', params: { to, subject: 'Hello', body: 'Hello' } }
}
