/**
 * Переключатель-«фишки» (радиокнопки): дисциплина, охват таблицы, сезон. Подпись группы — legend для диктора,
 * на экране её можно скрыть (hideLegend).
 * @param {{ name: string, legend: string, value: string, options: [string, string][], onChange: (v: string) => void, hideLegend?: boolean }} props
 */
export function Seg({ name, legend, value, options, onChange, hideLegend = false }) {
  return (
    <fieldset class="seg">
      <legend class={hideLegend ? 'visually-hidden' : 'seg__legend'}>{legend}</legend>
      <div class="seg__row">
        {options.map(([v, label]) => (
          <label class="seg__item" key={v}>
            <input type="radio" name={name} checked={value === v} onChange={() => onChange(v)} />
            <span class="seg__box">{label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
