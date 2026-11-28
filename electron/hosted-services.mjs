/** OpenMausBot's hosted services: MausBot Cloud, the MausBot account with its phone and push relays, organization
 * sign-in through the OpenMausBot Admin, the shared connected-apps broker, the MausBot team's bug-report endpoint and
 * its PostHog usage analytics. This fork offers none of them. */
export const OPENMAUSBOT_HOSTED = false;

/** Main passes this to a page's preload only when the hosted services are offered. */
export const HOSTED_SERVICES_ARG = "--omb-hosted-services=1";

/** The preload arguments of this app's own page on the installed desktop (`local`): the company desktop's, and the
 * hosted services' where they are offered. */
export function companyDesktopArguments(local, hosted = OPENMAUSBOT_HOSTED) {
  if (!local) return [];
  return hosted ? ["--omb-company-desktop=1", HOSTED_SERVICES_ARG] : ["--omb-company-desktop=1"];
}
