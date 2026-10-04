<script setup lang="ts">
// <UploadNotice>: what the board says when an upload is refused for a reason the kit's notices do not say
// well: the file is over what this site passes on, it is not a kind of file the reader takes, two of the
// visitor's documents are still being read, or every reader is busy. Each has its own sentence, in the
// visitor's language and from the locale files (never from the response), and says what to do next.
import { LbIcon } from '@lb/icons'
import { useI18n } from 'vue-i18n'

import { LB03_SITE_FILE_BYTES } from '#shared/lb03-limits'

import type { UploadRefusal } from '../refusals'

defineProps<{
  /** Which refusal this is. */
  kind: UploadRefusal
}>()

const { t } = useI18n()

// The site's limit in megabytes, as the datasheet says it ("4 MB").
const limitMegabytes = LB03_SITE_FILE_BYTES / 1_048_576
</script>

<template>
  <div
    class="notice"
    role="alert"
    :data-kind="kind"
    data-testid="upload-notice"
  >
    <LbIcon
      name="warning"
      :size="20"
    />
    <div class="body">
      <p class="title">
        {{ t(`lb03.refusals.${kind}.title`) }}
      </p>
      <p class="text">
        {{ t(`lb03.refusals.${kind}.text`, { size: limitMegabytes }) }}
      </p>
    </div>
  </div>
</template>

<style scoped>
.notice {
  display: flex;
  gap: 12px;
  padding: 12px 14px;
  background: var(--lb-shade);
  border: 1.5px solid var(--lb-ink);
}

.body {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.title {
  font-weight: 700;
}

.text {
  font-size: 14px;
}
</style>
