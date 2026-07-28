const KOREA_TIME_ZONE = "Asia/Seoul";
const ONE_DAY_IN_MILLISECONDS = 24 * 60 * 60 * 1000;

const koreaDateFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: KOREA_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
});

export function koreaTodayDateInput(now = new Date()) {
  return koreaDateInput(now);
}

export function koreaYesterdayDateInput(now = new Date()) {
  return koreaDateInput(new Date(now.getTime() - ONE_DAY_IN_MILLISECONDS));
}

function koreaDateInput(date: Date) {
  const parts = Object.fromEntries(
    koreaDateFormatter
      .formatToParts(date)
      .filter((part) => part.type === "year" || part.type === "month" || part.type === "day")
      .map((part) => [part.type, part.value])
  );

  return `${parts.year}-${parts.month}-${parts.day}`;
}
