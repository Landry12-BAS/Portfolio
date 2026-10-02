<script setup lang="ts">
// <AgentConsole>: the support agent's desk. It shows the ticket the pipeline has worked on, who
// wrote it and what the pipeline decided, the cited draft reply with its sources, and the three
// things a person can do with a draft: approve it, edit it, or hand it to a senior agent. Nothing
// here ever sends anything: auto-send is off for visitors, so a decision is recorded and that is
// all. In a replay the decisions are off, because there is no ticket on a back end to decide on.
import { LbIcon } from '@lb/icons'
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import { formatMoment } from '~/board-kit/format'
import type { ApiProblem } from '~/board-kit/problem'

import type { Ticket } from '../schemas'
import type { DecisionAction } from '../store'

import DraftView from './DraftView.vue'

const props = defineProps<{
  ticket: Ticket | undefined
  /** True while the pipeline is still working on the ticket. */
  working: boolean
  /** Whether the visitor may decide: a live run whose draft is waiting for a person. */
  canDecide: boolean
  /** True while the board replays a recording, where nothing can be decided. */
  replay: boolean
  deciding: boolean
  decisionProblem: ApiProblem | undefined
}>()

const emit = defineEmits<{ decide: [action: DecisionAction, text?: string] }>()

const { t, locale } = useI18n()

// The categories the pipeline can choose, so a value outside them is shown as "something else", not as raw text.
const CATEGORIES = new Set(['damaged', 'late', 'wrong_item', 'return', 'subscription', 'order_change', 'product', 'other'])
// The reasons a ticket is handed to a person without a draft.
const REASONS = new Set(['injection', 'unchecked', 'senior_agent', 'no_policy', 'pipeline_error'])
// The longest reply a person may write when editing.
const MAX_REPLY = 2_000

const editing = ref(false)
const editText = ref('')
const editBox = ref<HTMLTextAreaElement>()

const draftText = computed(() => props.ticket?.draft?.sentences.map(sentence => sentence.text).join(' ') ?? '')
const categoryKey = computed(() => (props.ticket && CATEGORIES.has(props.ticket.category) ? props.ticket.category : 'other'))
const reasonKey = computed(() => (props.ticket && REASONS.has(props.ticket.escalation_reason) ? props.ticket.escalation_reason : undefined))
const canSendEdit = computed(() => editText.value.trim().length > 0 && editText.value.length <= MAX_REPLY && !props.deciding)

/** Opens the editor with the draft as its starting text, and puts the cursor in it. */
async function startEdit(): Promise<void> {
  editText.value = draftText.value
  editing.value = true
  await nextTick()
  editBox.value?.focus()
}

/** Records the edited reply. */
function sendEdit(): void {
  if (canSendEdit.value) emit('decide', 'edit', editText.value.trim())
}

// Once a decision is recorded the editor has nothing more to do.
watch(() => props.ticket?.decision, () => {
  editing.value = false
})
</script>

<template>
  <section
    class="console"
    :aria-label="t('lb01.console.title')"
    data-testid="console"
  >
    <h2 class="lb-label">
      {{ t('lb01.console.title') }}
    </h2>

    <p
      v-if="!ticket"
      class="quiet"
    >
      {{ t('lb01.console.empty') }}
    </p>
    <p
      v-else-if="working"
      class="quiet"
      role="status"
    >
      {{ t('lb01.console.working') }}
    </p>

    <template v-else>
      <dl class="facts">
        <div>
          <dt>{{ t('lb01.console.from') }}</dt>
          <dd>{{ ticket.customer.name }}</dd>
        </div>
        <div>
          <dt>{{ t('lb01.console.category') }}</dt>
          <dd>{{ t(`lb01.console.categories.${categoryKey}`) }}</dd>
        </div>
        <div v-if="ticket.order_number">
          <dt>{{ t('lb01.console.order') }}</dt>
          <dd class="mono">
            {{ ticket.order_number }}
          </dd>
        </div>
        <div>
          <dt>{{ t('lb01.console.status') }}</dt>
          <dd data-testid="ticket-status">
            {{ t(`lb01.console.statuses.${ticket.status}`) }}
          </dd>
        </div>
        <div>
          <dt>{{ t('lb01.console.expires') }}</dt>
          <dd>{{ formatMoment(ticket.expires_at, locale) }}</dd>
        </div>
      </dl>

      <figure class="wrote">
        <figcaption class="lb-label">
          {{ t('lb01.console.customerWrote') }}
        </figcaption>
        <blockquote
          :lang="ticket.language"
          data-testid="ticket-body"
        >
          {{ ticket.body }}
        </blockquote>
      </figure>

      <div
        v-if="ticket.draft"
        class="block"
      >
        <h3 class="lb-label">
          {{ t('lb01.console.draft') }}
        </h3>
        <DraftView
          :draft="ticket.draft"
          :language="ticket.language"
        />
      </div>
      <p
        v-else
        class="handoff"
        data-testid="handoff"
      >
        <LbIcon
          name="shield"
          :size="18"
        />
        <span>{{ reasonKey ? t(`lb01.console.reasons.${reasonKey}`) : t('lb01.console.noDraft') }}</span>
      </p>

      <div
        v-if="ticket.decision"
        class="decision"
        data-testid="decision"
      >
        <h3 class="lb-label">
          {{ t('lb01.console.decision') }}
        </h3>
        <p class="decided">
          {{ t(`lb01.console.decided.${ticket.decision.action}`) }}
        </p>
        <p
          v-if="ticket.decision.final_text"
          class="final"
          :lang="ticket.language"
        >
          {{ ticket.decision.final_text }}
        </p>
        <p class="note">
          {{ t('lb01.console.autoSendOff') }}
        </p>
      </div>

      <div
        v-else-if="ticket.draft"
        class="actions"
      >
        <template v-if="canDecide">
          <div
            v-if="!editing"
            class="buttons"
          >
            <button
              type="button"
              class="button button--primary"
              :disabled="deciding"
              @click="emit('decide', 'approve')"
            >
              {{ t('lb01.console.approve') }}
            </button>
            <button
              type="button"
              class="button"
              :disabled="deciding"
              @click="startEdit"
            >
              {{ t('lb01.console.edit') }}
            </button>
            <button
              type="button"
              class="button"
              :disabled="deciding"
              @click="emit('decide', 'escalate')"
            >
              {{ t('lb01.console.escalate') }}
            </button>
          </div>
          <div
            v-else
            class="editor"
          >
            <label
              class="editor-label"
              for="lb01-edit"
            >{{ t('lb01.console.editLabel') }}</label>
            <textarea
              id="lb01-edit"
              ref="editBox"
              v-model="editText"
              class="textarea"
              rows="6"
              :maxlength="MAX_REPLY"
              :lang="ticket.language"
            />
            <div class="buttons">
              <button
                type="button"
                class="button button--primary"
                :disabled="!canSendEdit"
                @click="sendEdit"
              >
                {{ t('lb01.console.sendEdited') }}
              </button>
              <button
                type="button"
                class="button"
                :disabled="deciding"
                @click="editing = false"
              >
                {{ t('lb01.console.cancelEdit') }}
              </button>
            </div>
          </div>
          <p class="note">
            {{ t('lb01.console.autoSendOff') }}
          </p>
        </template>
        <p
          v-else-if="replay"
          class="note"
        >
          {{ t('lb01.console.replayNoDecisions') }}
        </p>
        <BoardNotice
          v-if="decisionProblem"
          :kind="decisionProblem.kind"
          :resets-at="decisionProblem.resetsAt"
        />
      </div>
    </template>
  </section>
</template>

<style scoped>
.console {
  display: grid;
  gap: 14px;
  min-width: 0;
}

.quiet {
  font-size: 14px;
  color: var(--lb-graphite);
}

.facts {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 22px;
  margin: 0;
}

.facts div {
  display: grid;
  gap: 1px;
}

.facts dt {
  font-family: var(--lb-font-mono);
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--lb-graphite);
}

.facts dd {
  margin: 0;
  font-size: 14px;
}

.mono {
  font-family: var(--lb-font-mono);
  font-size: 13px;
}

.wrote {
  display: grid;
  gap: 4px;
  margin: 0;
}

blockquote {
  padding: 8px 12px;
  margin: 0;
  font-style: italic;
  background: var(--lb-shade);
  border-left: 3px solid var(--lb-rule);
}

.block {
  display: grid;
  gap: 6px;
}

.handoff {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 10px 12px;
  background: var(--lb-shade);
  border: 1.5px solid var(--lb-ink);
}

.decision {
  display: grid;
  gap: 6px;
  padding: 10px 12px;
  border: 1.5px solid var(--lb-board);
  background: var(--lb-board-tint);
}

.decided {
  font-weight: 700;
}

.final {
  padding: 6px 10px;
  background: var(--lb-sheet);
  border-left: 3px solid var(--lb-board);
}

.note {
  font-size: 12.5px;
  color: var(--lb-graphite);
}

.actions {
  display: grid;
  gap: 10px;
}

.buttons {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.button {
  padding: 8px 16px;
  font: 600 13.5px/1 var(--lb-font-sans);
  color: var(--lb-ink);
  cursor: pointer;
  background: transparent;
  border: 1.5px solid var(--lb-ink);
  border-radius: 4px;
}

.button:hover:not(:disabled) {
  background: var(--lb-shade);
}

.button--primary {
  color: var(--lb-sheet);
  background: var(--lb-ink);
}

.button--primary:hover:not(:disabled) {
  background: var(--lb-ink-hover);
}

.button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.editor {
  display: grid;
  gap: 6px;
}

.editor-label {
  font-size: 13px;
  font-weight: 700;
}

.textarea {
  width: 100%;
  padding: 8px 10px;
  font: 400 14px/1.5 var(--lb-font-sans);
  color: var(--lb-ink);
  resize: vertical;
  background: var(--lb-sheet);
  border: 1.5px solid var(--lb-ink);
  border-radius: 4px;
}
</style>
