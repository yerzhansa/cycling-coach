interface DialogGaps {
  showModal?: () => void;
  close?: (returnValue?: string) => void;
}

export function installDialog(): void {
  if (typeof HTMLDialogElement === "undefined") return;
  const prototype = HTMLDialogElement.prototype as HTMLDialogElement & DialogGaps;
  if (typeof prototype.showModal !== "function") {
    prototype.showModal = function showModal(this: HTMLDialogElement): void {
      this.setAttribute("open", "");
    };
  }
  if (typeof prototype.close !== "function") {
    prototype.close = function close(this: HTMLDialogElement): void {
      this.removeAttribute("open");
      this.dispatchEvent(new Event("close"));
    };
  }
}
