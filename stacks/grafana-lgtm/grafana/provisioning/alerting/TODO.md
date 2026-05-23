# Peep Bot alerting — follow-ups

Tracking alerts that were scoped out of the first cut because the underlying
metrics aren't being exported yet.

## Resilience4j circuit breaker state

**Wanted:** alert when the `discord` or `tfnsw` circuit breaker is OPEN for >2m.

**Blocker:** `resilience4j_*` metrics aren't present in Prometheus. The Spring
Boot side likely needs the `resilience4j-micrometer` binding wired
(`TaggedCircuitBreakerMetrics.ofCircuitBreakerRegistry(...)` registered against
the `MeterRegistry`), or the existing binding isn't being exported via the
OTel pipeline.

**Once available**, add to `peepbot-critical`:

```yaml
- uid: peepbot-discord-cb-open
  title: Discord circuit breaker OPEN
  expr: max(resilience4j_circuitbreaker_state{name="discord", state="open"}) > 0
  for: 2m
  severity: critical
```

And the same for `name="tfnsw"` as a warning (longer `for:` since the TfNSW
feature is non-critical).

## Security signals

The following live only in logs today; alerts would need either log-based
Loki rules or new counters:

- **Rate limit storm**: `RateLimitFilter` logs `"Rate limit exceeded for key=..."`
  — a Loki count-over-time rule would work, but distinguishing
  "one client misbehaving" from "broad attack" needs the `key=` label parsed out.
- **IDOR probing**: 403s from `GuildMembershipService.assertMember` are not
  counted separately from other 403s. A dedicated counter
  (`security_guild_membership_denied_total`) would let us alert on spikes.
- **Anon session row growth**: would need a Postgres exporter query
  `SELECT count(*) FROM spring_session WHERE principal_name IS NULL`.
  Acts as the F-002 regression detector — if
  `AnonymousSkippingSessionRepository` is ever unwrapped, this climbs fast.

## ShedLock stale holders

ShedLock state lives in the `shedlock` table; a stale `lock_until` indicates a
crashed worker still holding a job lock. No metric today. Easiest fix is a
small `@Scheduled` exporter that publishes a gauge per lock name.

## 10062 metric (vs log signal)

The current alert uses Loki (`|= "10062"`). A dedicated counter incremented
inside the JDA error handler would be more reliable (logs can be dropped /
sampled), but the log-based rule is sufficient until then.
