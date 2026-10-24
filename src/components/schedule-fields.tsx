import type {
  FieldErrors,
  TimeWindow,
  UserContext,
} from "@/lib/domain/context";
import { Field, fieldAttributes } from "./form-fields";

export function ScheduleFields({
  context,
  update,
  errors,
}: {
  context: UserContext;
  update: (context: UserContext) => void;
  errors: FieldErrors;
}) {
  const attrs = (id: string, hint = false) => fieldAttributes(id, errors, hint);
  const newWindow = () => ({
    date: context.trip.start,
    start: "14:00",
    end: "17:00",
  });
  function windowEditor(
    row: TimeWindow & { title?: string },
    index: number,
    kind: "availability" | "commitments",
  ) {
    const path = `${kind}.${kind === "availability" ? "windows" : "items"}.${index}`;
    const patch = (values: Partial<TimeWindow> & { title?: string }) => {
      if (kind === "availability")
        update({
          ...context,
          availability: {
            ...context.availability,
            windows: context.availability.windows.map((item, i) =>
              i === index ? { ...item, ...values } : item,
            ),
          },
        });
      else
        update({
          ...context,
          commitments: {
            ...context.commitments,
            items: context.commitments.items.map((item, i) =>
              i === index ? { ...item, ...values } : item,
            ),
          },
        });
    };
    const remove = () => {
      if (kind === "availability")
        update({
          ...context,
          availability: {
            ...context.availability,
            windows: context.availability.windows.filter((_, i) => i !== index),
          },
        });
      else
        update({
          ...context,
          commitments: {
            ...context.commitments,
            items: context.commitments.items.filter((_, i) => i !== index),
          },
        });
    };
    return (
      <div className="time-window" key={index}>
        <div className="window-heading">
          <span>
            {kind === "availability" ? "Franja" : "Compromiso"} {index + 1}
          </span>
          <button
            type="button"
            className="remove-button"
            onClick={remove}
            aria-label={`Eliminar ${kind === "availability" ? "franja" : "compromiso"} ${index + 1}`}
          >
            Eliminar
          </button>
        </div>
        {kind === "commitments" && (
          <Field
            id={`${path}.title`}
            label="Nombre del compromiso"
            error={errors[`${path}.title`]}
          >
            <input
              {...attrs(`${path}.title`)}
              value={row.title ?? ""}
              onChange={(e) => patch({ title: e.target.value })}
              maxLength={120}
              placeholder="Cena con el equipo"
            />
          </Field>
        )}
        <Field id={`${path}.date`} label="Día" error={errors[`${path}.date`]}>
          <input
            {...attrs(`${path}.date`)}
            type="date"
            value={row.date}
            min={context.trip.start || undefined}
            max={context.trip.end || undefined}
            onChange={(e) => patch({ date: e.target.value })}
          />
        </Field>
        <div className="field-pair">
          {(["start", "end"] as const).map((key) => (
            <Field
              key={key}
              id={`${path}.${key}`}
              label={key === "start" ? "Desde" : "Hasta"}
              error={errors[`${path}.${key}`]}
            >
              <input
                {...attrs(`${path}.${key}`)}
                type="time"
                value={row[key]}
                onChange={(e) => patch({ [key]: e.target.value })}
              />
            </Field>
          ))}
        </div>
      </div>
    );
  }
  return (
    <>
      <div className="timezone-note">
        <span aria-hidden="true">◷</span>
        <div>
          <strong>San Francisco</strong>
          <span>Todos los horarios están en la hora del Pacífico.</span>
        </div>
      </div>
      <div className="field-pair">
        {(["start", "end"] as const).map((key) => (
          <Field
            key={key}
            id={`trip.${key}`}
            label={key === "start" ? "Llegada" : "Salida"}
            error={errors[`trip.${key}`]}
          >
            <input
              {...attrs(`trip.${key}`)}
              type="date"
              value={context.trip[key]}
              min={key === "end" ? context.trip.start || undefined : undefined}
              onChange={(e) =>
                update({
                  ...context,
                  trip: { ...context.trip, [key]: e.target.value },
                })
              }
            />
          </Field>
        ))}
      </div>
      <section className="schedule-section">
        <h2>¿Cuándo puedes conversar?</h2>
        <p className="field-hint">
          Añade algunas franjas. Restaremos tus compromisos fijos.
        </p>
        <div className="choice-row">
          {[
            { value: "unknown", label: "Aún no lo sé" },
            { value: "provided", label: "Añadir franjas" },
          ].map((option) => (
            <label key={option.value}>
              <input
                type="radio"
                name="availability-status"
                checked={context.availability.status === option.value}
                onChange={() =>
                  update({
                    ...context,
                    availability:
                      option.value === "provided"
                        ? { status: "provided", windows: [newWindow()] }
                        : { status: "unknown", windows: [] },
                  })
                }
              />
              {option.label}
            </label>
          ))}
        </div>
        {context.availability.status === "provided" && (
          <div id="availability.windows" tabIndex={-1} className="windows-list">
            {context.availability.windows.map((row, i) =>
              windowEditor(row, i, "availability"),
            )}
            {errors["availability.windows"] && (
              <p className="field-error">{errors["availability.windows"]}</p>
            )}
            <button
              type="button"
              className="add-button"
              disabled={context.availability.windows.length >= 14}
              onClick={() =>
                update({
                  ...context,
                  availability: {
                    ...context.availability,
                    windows: [...context.availability.windows, newWindow()],
                  },
                })
              }
            >
              + Añadir otra franja
            </button>
          </div>
        )}
      </section>
      <section className="schedule-section">
        <h2>¿Hay algo que debamos respetar?</h2>
        <p className="field-hint">
          Reuniones, cenas o planes que ya tienen su sitio.
        </p>
        <div className="choice-row commitments-choices">
          {[
            { value: "unknown", label: "Por revisar" },
            { value: "none", label: "No tengo compromisos" },
            { value: "provided", label: "Añadir" },
          ].map((option) => (
            <label key={option.value}>
              <input
                type="radio"
                name="commitments-status"
                checked={context.commitments.status === option.value}
                onChange={() =>
                  update({
                    ...context,
                    commitments:
                      option.value === "provided"
                        ? {
                            status: "provided",
                            items: [
                              {
                                ...newWindow(),
                                start: "18:00",
                                end: "19:00",
                                title: "",
                              },
                            ],
                          }
                        : {
                            status: option.value as "none" | "unknown",
                            items: [],
                          },
                  })
                }
              />
              {option.label}
            </label>
          ))}
        </div>
        {context.commitments.status === "provided" && (
          <div id="commitments.items" tabIndex={-1} className="windows-list">
            {context.commitments.items.map((row, i) =>
              windowEditor(row, i, "commitments"),
            )}
            {errors["commitments.items"] && (
              <p className="field-error">{errors["commitments.items"]}</p>
            )}
            <button
              type="button"
              className="add-button"
              disabled={context.commitments.items.length >= 12}
              onClick={() =>
                update({
                  ...context,
                  commitments: {
                    ...context.commitments,
                    items: [
                      ...context.commitments.items,
                      {
                        ...newWindow(),
                        start: "18:00",
                        end: "19:00",
                        title: "",
                      },
                    ],
                  },
                })
              }
            >
              + Añadir otro compromiso
            </button>
          </div>
        )}
      </section>
      <details
        className="optional-details"
        open={errors["preferences.budgetUsd"] ? true : undefined}
      >
        <summary>
          Un par de preferencias <span>Opcional</span>
        </summary>
        <div className="optional-fields">
          <Field
            id="preferences.meetingFormat"
            label="¿Qué formato te gusta más?"
          >
            <select
              {...attrs("preferences.meetingFormat")}
              value={context.preferences.meetingFormat}
              onChange={(e) =>
                update({
                  ...context,
                  preferences: {
                    ...context.preferences,
                    meetingFormat: e.target
                      .value as UserContext["preferences"]["meetingFormat"],
                  },
                })
              }
            >
              <option value="any">Me adapto</option>
              <option value="one_to_one">Conversaciones 1 a 1</option>
              <option value="small_groups">Grupos pequeños</option>
            </select>
          </Field>
          <Field
            id="preferences.budgetUsd"
            label="Presupuesto máximo por evento (USD)"
            hint="Déjalo vacío si todavía no tienes un límite."
            error={errors["preferences.budgetUsd"]}
          >
            <input
              {...attrs("preferences.budgetUsd", true)}
              type="number"
              min="0"
              max="10000"
              step="0.01"
              inputMode="decimal"
              value={context.preferences.budgetUsd ?? ""}
              onChange={(e) =>
                update({
                  ...context,
                  preferences: {
                    ...context.preferences,
                    budgetUsd:
                      e.target.value === "" ? null : Number(e.target.value),
                  },
                })
              }
              placeholder="Sin definir"
            />
          </Field>
        </div>
      </details>
    </>
  );
}
