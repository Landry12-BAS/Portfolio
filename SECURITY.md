# Security policy

## Reporting a vulnerability

Report security issues privately through GitHub: open this repository's **Security**
tab and choose **Report a vulnerability**. Please don't open a public issue.

The owner aims to acknowledge a report within three days and to share a fix or a plan
within two weeks.

## Scope

- In scope: the live site and every LB system on it, including the AI features.
  Prompt injections or jailbreaks that make a system break its own rules, leak data or
  spend quota beyond its limits count.
- Out of scope: denial of service by volume, automated scanner output without a
  working proof, and the third-party model providers themselves.

Every demo runs on synthetic data, so no real customer data is at risk. The security
design is in [`docs/SECURITY.md`](docs/SECURITY.md).
