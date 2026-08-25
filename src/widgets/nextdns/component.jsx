import Block from "components/services/widget/block";
import Container from "components/services/widget/container";
import { useTranslation } from "next-i18next/pages";

import useWidgetAPI from "utils/proxy/use-widget-api";

// NextDNS gives every profile two globally-unique IPv6 addresses that don't need "linked IP"
// setup: the profile id (zero-padded to 8 hex chars) becomes the last two address groups.
// See https://help.nextdns.io/t/g9h7bny/correct-ipv6-address-for-nextdns-servers
function dnsServerAddresses(profile) {
  const padded = profile.padStart(8, "0").slice(-8);
  const high = padded.slice(0, 4).replace(/^0+(?=.)/, "");
  const low = padded.slice(4, 8);
  return [`2a07:a8c0::${high}:${low}`, `2a07:a8c1::${high}:${low}`];
}

export default function Component({ service }) {
  const { t } = useTranslation();

  const { widget } = service;
  const showDevices = widget.view === "devices";

  // analytics/status is always fetched: it's the only endpoint that breaks queries down by
  // status, which the total/blocked summary blocks need regardless of the selected view.
  const { data: statusData, error: statusError } = useWidgetAPI(widget, "analytics/status");
  const { data: devicesData, error: devicesError } = useWidgetAPI(widget, showDevices ? "analytics/devices" : "");

  const nextdnsError = statusError || devicesError;
  if (nextdnsError) {
    return <Container service={service} error={nextdnsError} />;
  }

  const breakdownData = showDevices ? devicesData : statusData;

  if (!statusData || (showDevices && !devicesData)) {
    return (
      <Container service={service}>
        <Block key="status" label="widget.status" value={t("nextdns.wait")} />
      </Container>
    );
  }

  if (!breakdownData?.data?.length) {
    return (
      <Container service={service}>
        <Block key="status" label="widget.status" value={t("nextdns.no_devices")} />
      </Container>
    );
  }

  const totalQueries = statusData.data.reduce((sum, d) => sum + d.queries, 0);
  const blockedQueries = statusData.data.filter((d) => d.status === "blocked").reduce((sum, d) => sum + d.queries, 0);
  const [primaryDns, secondaryDns] = dnsServerAddresses(widget.profile);

  return (
    <>
      <Container service={service}>
        <Block key="total" label="nextdns.total_queries" value={t("common.number", { value: totalQueries })} />
        <Block key="blocked" label="nextdns.blocked_queries" value={t("common.number", { value: blockedQueries })} />
        <Block key="config_id" label="nextdns.config_id" value={widget.profile} />
        <Block key="dns_primary" label="nextdns.dns_primary" value={primaryDns} />
        <Block key="dns_secondary" label="nextdns.dns_secondary" value={secondaryDns} />
      </Container>
      <Container service={service}>
        {showDevices
          ? breakdownData.data.map((d) => (
              <Block key={d.id} label={d.name ?? d.id} value={t("common.number", { value: d.queries })} />
            ))
          : breakdownData.data.map((d) => (
              <Block key={d.status} label={d.status} value={t("common.number", { value: d.queries })} />
            ))}
      </Container>
    </>
  );
}
