// The words the board says about an incident, in the visitor's language, built from what the
// service sends. Everything the service sends that the page shows is a closed name (a service, a
// metric, a state, a kind of event, an action) or a number, so the words come from the locale files
// by name and never from the service: a name the page has no words for is shown as the name itself,
// and nothing the service writes is ever put into the page as text of its own, except the agents'
// sentences, which are shown as plain text and nothing else.
import type { Lb06Action, Lb06Event, Lb06Metric } from '@lb/contracts'
import { useI18n } from 'vue-i18n'
import { formatCount } from '~/board-kit/format'
import type { MarkerKind } from './incident'

/** The words of the board, as functions the components call. */
export interface Lb06Words {
  serviceName: (service: string) => string
  metricName: (metric: string) => string
  healthWord: (health: string) => string
  stateWord: (state: string) => string
  faultName: (fault: string) => string
  causeWord: (cause: string) => string
  agentName: (agent: string) => string
  endReasonWord: (reason: string | null | undefined) => string
  markerName: (kind: MarkerKind) => string
  markerLetter: (kind: MarkerKind) => string
  actionText: (action: Lb06Action) => string
  blastText: (action: Lb06Action) => string
  valueText: (metric: Lb06Metric, value: number) => string
  eventText: (event: Lb06Event) => string
}

/** Builds the words for the language the page is in. */
export function useLb06Words(): Lb06Words {
  const { t, te, locale } = useI18n()

  /** Says a name by its key, or the name itself when the page has no words for it. */
  function named(group: string, name: string): string {
    const key = `lb06.${group}.${name}`
    return te(key) ? t(key) : name
  }

  /** Writes a number the way the visitor's language does, with a number of decimals. */
  function number(value: number, decimals: number): string {
    return new Intl.NumberFormat(locale.value, { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(value)
  }

  /** Says a metric's number with its unit. */
  function valueText(metric: Lb06Metric, value: number): string {
    switch (metric) {
      case 'error_rate': return t('lb06.value.percent', { value: number(value * 100, value < 0.1 ? 1 : 0) })
      case 'saturation': return t('lb06.value.percent', { value: number(value * 100, 0) })
      case 'latency_p50':
      case 'latency_p95':
      case 'latency_p99':
        return t('lb06.value.ms', { value: formatCount(Math.round(value), locale.value) })
      case 'memory_mb': return t('lb06.value.mb', { value: formatCount(Math.round(value), locale.value) })
      case 'request_rate': return t('lb06.value.perSecond', { value: number(value, 1) })
    }
  }

  /** The words of an action, from its kind and parameters. */
  function actionText(action: Lb06Action): string {
    switch (action.kind) {
      case 'rollback': return t('lb06.actions.rollback', { service: named('services', action.service), toVersion: action.toVersion })
      case 'restart': return t('lb06.actions.restart', { service: named('services', action.service) })
      case 'scale': return t('lb06.actions.scale', { service: named('services', action.service), replicas: action.replicas })
      case 'flush_cache': return t('lb06.actions.flush_cache')
      case 'flip_flag': return t('lb06.actions.flip_flag', { flag: action.flag, value: t(`lb06.flagValue.${action.value ? 'on' : 'off'}`) })
    }
  }

  /** What an action touches, in plain words. */
  function blastText(action: Lb06Action): string {
    switch (action.kind) {
      case 'rollback': return t('lb06.blast.rollback', { service: named('services', action.service), toVersion: action.toVersion })
      case 'restart': return t('lb06.blast.restart', { service: named('services', action.service) })
      case 'scale': return t('lb06.blast.scale', { service: named('services', action.service) })
      case 'flush_cache': return t('lb06.blast.flush_cache')
      case 'flip_flag': return t('lb06.blast.flip_flag')
    }
  }

  /** Says a fault's title. */
  function faultName(fault: string): string {
    const key = `lb06.faults.${fault}.title`
    return te(key) ? t(key) : fault
  }

  /** Says one event of the log as a sentence. */
  function eventText(event: Lb06Event): string {
    const key = `lb06.events.${event.kind.replace('.', '_')}`
    switch (event.kind) {
      case 'fault.injected': return t(key, { fault: faultName(event.data.fault), service: named('services', event.data.service) })
      case 'alert.fired': return t(key, { shortBurn: number(event.data.burn.shortBurn, 1), short: event.data.burn.shortMinutes, longBurn: number(event.data.burn.longBurn, 1), long: event.data.burn.longMinutes })
      case 'evidence.discarded': return t(key, { agent: named('agents.names', event.data.agent), count: event.data.count })
      case 'hypotheses.ranked': {
        const top = event.data.hypotheses[0]
        return t(key, { service: top ? named('services', top.service) : '', cause: top ? named('hypotheses.causes', top.cause) : '' })
      }
      case 'proposal.made': return t(key, { proposalId: event.data.proposalId, action: actionText(event.data.action) })
      case 'proposal.approved':
      case 'proposal.rejected':
        return t(key, { proposalId: event.data.proposalId })
      case 'remediation.applied': return t(key, { action: actionText(event.data.action) })
      case 'slo.recovered': return t(key, { minutes: event.data.healthyMinutes })
      case 'incident.aborted':
      case 'incident.failed':
        return t(key, { reason: endReasonWord(event.data.reason) })
      default: return te(key) ? t(key) : event.kind
    }
  }

  /** Says why an incident ended early. */
  function endReasonWord(reason: string | null | undefined): string {
    return reason ? named('endReasons', reason) : ''
  }

  return {
    serviceName: service => named('services', service),
    metricName: metric => named('metrics', metric),
    healthWord: health => named('health', health),
    stateWord: state => named('states', state),
    faultName,
    causeWord: cause => named('hypotheses.causes', cause),
    agentName: agent => named('agents.names', agent),
    endReasonWord,
    markerName: kind => t(`lb06.dashboard.markers.${kind}`),
    markerLetter: kind => t(`lb06.dashboard.markerLetters.${kind}`),
    actionText,
    blastText,
    valueText,
    eventText,
  }
}
