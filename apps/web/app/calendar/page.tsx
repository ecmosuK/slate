const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export const dynamic = "force-dynamic";

export default function CalendarPage() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const firstWeekday = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today = now.getDate();

  const cells: (number | null)[] = [
    ...Array.from({ length: firstWeekday }, () => null),
    ...Array.from({ length: daysInMonth }, (_, index) => index + 1),
  ];

  return (
    <main>
      <h1>Calendar</h1>
      <p className="subtitle">
        {now.toLocaleDateString(undefined, { month: "long", year: "numeric" })} · planning view
      </p>

      <section className="card">
        <div className="calendar">
          {WEEKDAYS.map((day) => (
            <div className="calendar-weekday" key={day}>
              {day}
            </div>
          ))}
          {cells.map((day, index) => (
            <div
              className={
                day === today ? "calendar-day today" : day === null ? "calendar-day blank" : "calendar-day"
              }
              key={`${day ?? "blank"}-${index}`}
            >
              {day ?? ""}
            </div>
          ))}
        </div>
      </section>

      <section className="card">
        <h2>Scheduling</h2>
        <p className="meta">
          Tasks and goals are not scheduled yet. The next step is to give goals dates, show them
          here, and then sync the result with Google Calendar.
        </p>
      </section>
    </main>
  );
}
