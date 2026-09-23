import flatpickr from "flatpickr";

type Picker = flatpickr.Instance;

const byRoot = new WeakMap<ParentNode, Picker[]>();
const byInput = new WeakMap<HTMLInputElement, Picker>();

export function attachDatePickers(root: ParentNode): void {
  for (const inst of byRoot.get(root) ?? []) inst.destroy();
  const created: Picker[] = [];
  root.querySelectorAll<HTMLInputElement>("input[data-datepicker]").forEach((input) => {
    const inst = flatpickr(input, {
      dateFormat: "Y-m-d",
      allowInput: true,
      disableMobile: true,
    });
    byInput.set(input, inst);
    created.push(inst);
  });
  byRoot.set(root, created);
}

export function setDatePickerValue(input: HTMLInputElement, value: string): void {
  const inst = byInput.get(input);
  if (inst) {
    if (value) inst.setDate(value, false, "Y-m-d");
    else inst.clear(false);
  } else {
    input.value = value;
  }
}
