"use client";

import React, { useEffect, useMemo, useState } from "react";

type FiatCurrency = "PLN" | "EUR" | "USD";
type MoneyCurrency = FiatCurrency | "USDT";

type Deal = {
  id: string;
  time: string; // HH:MM
  clientName: string;
  telegram: string;
  comment: string;
  amountIn: number;
  amountInCurrency: MoneyCurrency;
  amountOut: number;
  amountOutCurrency: MoneyCurrency;
  rate?: number;
  fee: number;
  feeCurrency: MoneyCurrency;
  fromWallet: string;
  toWallet: string;
  createdBy?: string;
  internalNote?: string;
  noteTags?: string[]; // tagi dla notek: "ważne", "do sprawdzenia" itd.
};

type Balances = {
  PLN: number;
  EUR: number;
  USD: number;
  USDT: number;
};

type UserRole = "admin" | "worker";

type User = {
  username: string;
  displayName: string;
  role: UserRole;
};

const USERS: Array<User & { password: string }> = [
  {
    username: "dasha",
    password: "dasha123",
    displayName: "Dasha",
    role: "admin",
  },
  {
    username: "pasha",
    password: "pasha123",
    displayName: "Pasha",
    role: "admin",
  },
  {
    username: "worker",
    password: "worker123",
    displayName: "Worker",
    role: "worker",
  },
];

const TODAY_KEY = () => new Date().toISOString().slice(0, 10);

const emptyBalances: Balances = {
  PLN: 0,
  EUR: 0,
  USD: 0,
  USDT: 0,
};

function formatMoney(value: number, currency: MoneyCurrency) {
  if (Number.isNaN(value)) return "—";
  const formatter = new Intl.NumberFormat("pl-PL", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${formatter.format(value)} ${currency}`;
}

function formatTime(date: Date) {
  return date.toTimeString().slice(0, 5);
}

function calcFeeInUsdt(amountIn: number, percent: number): number {
  if (!amountIn || !percent) return 0;
  return +(amountIn * (percent / 100)).toFixed(2);
}

function calculateCommission(
  manualFeeString: string,
  dealPercentString: string,
  dailyPercentString: string,
  amountIn: number,
  amountInCurrency: MoneyCurrency,
  amountOutCurrency: MoneyCurrency,
  rateNum?: number,
  apiRates?: ApiRates | null
): number {
  // 1) Jeśli użytkownik wpisał manualną kwotę prowizji — użyj jej (zakładamy, że jest w USDT)
  const manualFee = parseFloat(manualFeeString.replace(",", "."));
  if (!Number.isNaN(manualFee) && manualFeeString.trim() !== "") {
    return +manualFee.toFixed(2);
  }

  // 2) Jeśli jest procent na transakcji — używamy go zamiast szablonów
  const dealPercent = parseFloat(dealPercentString.replace(",", "."));
  if (!Number.isNaN(dealPercent) && dealPercentString.trim() !== "") {
    // zależnie od pary obliczamy w USDT
    if (amountInCurrency === "USDT") {
      return +(amountIn * (dealPercent / 100)).toFixed(2);
    }
    if (amountOutCurrency === "USDT") {
      // need rate to convert fiat -> USDT: grossUsdt = amountIn / rateNum
      if (!rateNum || rateNum === 0) return 0;
      const grossUsdt = amountIn / rateNum;
      return +(grossUsdt * (dealPercent / 100)).toFixed(2);
    }
    // fiat -> fiat: percent applies to amountOut (amountIn * rateNum)
    if (rateNum && rateNum !== 0) {
      const amountOut = amountIn * rateNum;
      const feeOut = amountOut * (dealPercent / 100);
      // convert fiat fee to USDT using apiRates (1 USDT = apiRates[fiat])
      const outFiat = amountOutCurrency as FiatCurrency;
      const fiatToUsdtRate = apiRates?.[outFiat];
      if (fiatToUsdtRate && fiatToUsdtRate !== 0) {
        return +(feeOut / fiatToUsdtRate).toFixed(2);
      }
    }
    return 0;
  }

  // 3) Brak manualnej prowizji i brak procentu — stosujemy szablony
  const dailyPercent = parseFloat(dailyPercentString.replace(",", "."));

  // A) USDT -> FIAT: szablony oparte na kwocie w USDT
  if (amountInCurrency === "USDT" && amountOutCurrency !== "USDT") {
    if (amountIn <= 1499) return 15;
    if (amountIn > 5000) return +(amountIn * -0.01).toFixed(2);
    return 0;
  }

  // B) FIAT -> USDT: liczymy najpierw gross w USDT
  if (amountInCurrency !== "USDT" && amountOutCurrency === "USDT") {
    if (!rateNum || rateNum === 0) return 0;
    const grossUsdt = amountIn / rateNum;
    if (grossUsdt <= 1000) return 20;
    return +(grossUsdt * 0.02).toFixed(2);
  }

  // C) FIAT -> FIAT: bez procentu = 0
  return 0;
}

function calculateAutoCommissionUsdt(
  amountInUsdt: number,
  defaultPercent: number,
  customPercent: number | null
): number {
  if (!amountInUsdt || amountInUsdt <= 0) return 0;

  const percent = customPercent ?? defaultPercent;

  // До 1000 USDT — фиксированная комиссия 20 USDT
  if (amountInUsdt < 1000) {
    return 20;
  }

  // От 1000 и выше — процент от суммы (может быть отрицательным)
  return +(amountInUsdt * percent / 100);
}

const STORAGE_BALANCES_KEY = "smart-exchange-balances-v1";
const STORAGE_DEALS_KEY = "smart-exchange-deals-v1";
const STORAGE_USER_KEY = "smart-exchange-current-user-v1";

type DealsByDate = Record<string, Deal[]>;
type DayNotes = Record<string, string>;

type ApiRates = {
  PLN: number;
  EUR: number;
  USD: number;
};

type ApiStatus = "idle" | "loading" | "ok" | "error";

export default function Page() {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [loginForm, setLoginForm] = useState({
    username: "",
    password: "",
    error: "",
  });

  const [activeTab, setActiveTab] = useState<"cryptoToFiat" | "fiatToCrypto">(
    "cryptoToFiat"
  );

  // --- Kalkulator: z krypto na FIAT ---
  const [cryptoAmount, setCryptoAmount] = useState<string>("500");
  const [cryptoOutputCurrency, setCryptoOutputCurrency] =
    useState<FiatCurrency>("PLN");
  const [cryptoRate, setCryptoRate] = useState<string>("4.2");
  const [useApiForCrypto, setUseApiForCrypto] = useState<boolean>(true);

  // --- Kalkulator: z FIAT na krypto ---
  const [fiatAmount, setFiatAmount] = useState<string>("500");
  const [fiatInputCurrency, setFiatInputCurrency] =
    useState<FiatCurrency>("PLN");
  const [fiatRate, setFiatRate] = useState<string>("4.2");
  const [useApiForFiat, setUseApiForFiat] = useState<boolean>(true);

  // --- Balans dnia + transakcje ---
  const [selectedDate, setSelectedDate] = useState<string>(TODAY_KEY());
  const [startBalances, setStartBalances] = useState<Balances>(emptyBalances);
  const [dealsByDate, setDealsByDate] = useState<DealsByDate>({});
  const [selectedDealIds, setSelectedDealIds] = useState<string[]>([]);
  const currentDeals = dealsByDate[selectedDate] || [];
  const allDates = useMemo(() => Object.keys(dealsByDate).sort().reverse(), [dealsByDate]);

  // Zbierz unikalne klientów i Telegram z historii dla podpowiedzi
  const uniqueClients = useMemo(() => {
    const clients = new Set<string>();
    Object.values(dealsByDate).forEach((deals) => {
      deals.forEach((d) => {
        if (d.clientName) clients.add(d.clientName);
      });
    });
    return Array.from(clients).sort();
  }, [dealsByDate]);

  const uniqueTelegramAccounts = useMemo(() => {
    const accounts = new Set<string>();
    Object.values(dealsByDate).forEach((deals) => {
      deals.forEach((d) => {
        if (d.telegram) accounts.add(d.telegram);
      });
    });
    return Array.from(accounts).sort();
  }, [dealsByDate]);

  // --- API kursów ---
  const [apiRates, setApiRates] = useState<ApiRates | null>(null);
  const [apiStatus, setApiStatus] = useState<ApiStatus>("idle");
  const [lastApiUpdate, setLastApiUpdate] = useState<string | null>(null);

  // --- Dzienna domyślna prowizja ---
  const [dailyFeePercent, setDailyFeePercent] = useState<string>("1.0");

  // Komisja i tryb manualny
  const [commission, setCommission] = useState<string>("0.00");
  const [isCommissionManual, setIsCommissionManual] = useState<boolean>(false);
  const [clientGets, setClientGets] = useState<string>("0.00");
  
  // Notatki na dzień
  const [dayNotes, setDayNotes] = useState<DayNotes>({});
  const currentNote = dayNotes[selectedDate] || "";
  // Internal note for new deal
  const [newDealInternalNote, setNewDealInternalNote] = useState<string>("");
  // formularz nowej transakcji
  const [newDeal, setNewDeal] = useState({
    clientName: "",
    telegram: "",
    comment: "",
    amountIn: "",
    amountInCurrency: "USDT" as MoneyCurrency,
    amountOut: "",
    amountOutCurrency: "PLN" as MoneyCurrency,
    rate: "",
    fee: "",
    feeCurrency: "USDT" as MoneyCurrency,
    customPercent: "", // procent komisji (opcjonalnie)
    fromWallet: "",
    toWallet: "",
  });

  // ---- LOGIN: wczytaj użytkownika z localStorage ----
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const stored = window.localStorage.getItem(STORAGE_USER_KEY);
      if (stored) {
        const parsed = JSON.parse(stored) as User;
        setCurrentUser(parsed);
      }
    } catch (e) {
      console.error("Cannot read user from localStorage", e);
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (currentUser) {
      window.localStorage.setItem(STORAGE_USER_KEY, JSON.stringify(currentUser));
    } else {
      window.localStorage.removeItem(STORAGE_USER_KEY);
    }
  }, [currentUser]);

  // ---- DZIENNA PROWIZJA: wczytaj z localStorage ----
  useEffect(() => {
    if (typeof window === "undefined") return;
    const todayKey = TODAY_KEY();
    const storageKey = `daily-commission-${todayKey}`;
    try {
      const stored = window.localStorage.getItem(storageKey);
      if (stored) {
        setDailyFeePercent(stored);
      }
    } catch (e) {
      console.error("Cannot read daily commission from localStorage", e);
    }

    // Wczytaj ostatnio wybraną datę z localStorage
    try {
      const lastDate = window.localStorage.getItem("smart-exchange-last-selected-date");
      if (lastDate) {
        setSelectedDate(lastDate);
      }
    } catch (e) {
      console.error("Cannot read last selected date from localStorage", e);
    }
  }, []);

  // ---- Wczytaj dealsByDate z localStorage przy mountcie ----
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem("smartExchangeDealsByDate");
      if (raw) {
        const parsed = JSON.parse(raw) as DealsByDate;
        if (parsed && typeof parsed === "object") {
          setDealsByDate(parsed);
        }
      }
      // load day notes if present
      const rawNotes = window.localStorage.getItem("smart-exchange-day-notes");
      if (rawNotes) {
        try {
          const notesParsed = JSON.parse(rawNotes) as DayNotes;
          if (notesParsed && typeof notesParsed === "object") {
            setDayNotes(notesParsed);
          }
        } catch (e) {
          console.error("Cannot parse day notes from localStorage", e);
        }
      }
    } catch (e) {
      console.error("Cannot read dealsByDate from localStorage", e);
    }
  }, []);

  // ---- Zapisuj dealsByDate do localStorage przy każdej zmianie ----
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(
        "smartExchangeDealsByDate",
        JSON.stringify(dealsByDate)
      );
    } catch (e) {
      console.error("Cannot save dealsByDate to localStorage", e);
    }
  }, [dealsByDate]);

  // Save day notes to localStorage on change
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(
        "smart-exchange-day-notes",
        JSON.stringify(dayNotes)
      );
    } catch (e) {
      console.error("Cannot save day notes to localStorage", e);
    }
  }, [dayNotes]);

  // Zapamiętaj ostatnio wybraną datę w localStorage
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem("smart-exchange-last-selected-date", selectedDate);
    } catch (e) {
      console.error("Cannot save last selected date to localStorage", e);
    }
  }, [selectedDate]);

  const handleLogin = () => {
    const username = loginForm.username.trim().toLowerCase();
    const password = loginForm.password;

    const found = USERS.find(
      (u) => u.username.toLowerCase() === username && u.password === password
    );

    if (!found) {
      setLoginForm((p) => ({
        ...p,
        error: "Неверный логин или пароль.",
      }));
      return;
    }

    const { password: _pw, ...userData } = found;
    setCurrentUser(userData);
    setLoginForm({ username: "", password: "", error: "" });
  };

  const handleLogout = () => {
    setCurrentUser(null);
  };

  // ---- localStorage: wczytaj przy starcie ----
  useEffect(() => {
    if (typeof window === "undefined") return;

    try {
      const storedBalances = window.localStorage.getItem(STORAGE_BALANCES_KEY);
      if (storedBalances) {
        setStartBalances(JSON.parse(storedBalances));
      } else {
        setStartBalances({
          PLN: 1000000,
          EUR: 1000000,
          USD: 1000000,
          USDT: 1000000,
        });
      }
    } catch (e) {
      console.error("Cannot read balances from localStorage", e);
    }

    try {
      const storedDeals = window.localStorage.getItem(STORAGE_DEALS_KEY);
      if (storedDeals) {
        setDealsByDate(JSON.parse(storedDeals));
      }
    } catch (e) {
      console.error("Cannot read deals from localStorage", e);
    }
  }, []);

  // ---- localStorage: zapisz zmiany ----
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(
      STORAGE_BALANCES_KEY,
      JSON.stringify(startBalances)
    );
  }, [startBalances]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(STORAGE_DEALS_KEY, JSON.stringify(dealsByDate));
  }, [dealsByDate]);

  // === API RATES: pobieramy z CoinGecko ===
  useEffect(() => {
    if (typeof window === "undefined") return;

    const fetchRates = async () => {
      try {
        setApiStatus("loading");
        const res = await fetch(
          "https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=pln,eur,usd"
        );
        if (!res.ok) {
          throw new Error("Bad response from API");
        }
        const data = await res.json();
        const tether = data?.tether;
        if (
          !tether ||
          typeof tether.pln !== "number" ||
          typeof tether.eur !== "number" ||
          typeof tether.usd !== "number"
        ) {
          throw new Error("Invalid data from API");
        }
        const newRates: ApiRates = {
          PLN: tether.pln,
          EUR: tether.eur,
          USD: tether.usd,
        };
        setApiRates(newRates);
        setApiStatus("ok");
        setLastApiUpdate(new Date().toLocaleTimeString());
      } catch (e) {
        console.error("Failed to fetch API rates", e);
        setApiStatus("error");
      }
    };

    fetchRates();
    const id = setInterval(fetchRates, 60_000);
    return () => clearInterval(id);
  }, []);

  // === LOGIKA PROWIZJI: wspólne helpery ===

  // USDT → FIAT
  function calcCryptoToFiat(
    usdtAmount: number,
    rate: number
  ): { grossFiat: number; feeFiat: number; clientFiat: number } {
    const grossFiat = usdtAmount * rate;
    let feeFiat = 0;
    let clientFiat = grossFiat;

    if (usdtAmount <= 1499) {
      feeFiat = 15 * rate; // 15 USDT w FIAT
      clientFiat = grossFiat - feeFiat;
    } else if (usdtAmount > 5000) {
      clientFiat = grossFiat * 1.01;
      feeFiat = grossFiat * -0.01; // nasz koszt = -1%
    }
    return { grossFiat, feeFiat, clientFiat };
  }

  // FIAT → USDT
  function calcFiatToCrypto(
    fiatAmount: number,
    rate: number
  ): { grossUsdt: number; feeUsdt: number; clientUsdt: number } {
    const grossUsdt = fiatAmount / rate;
    let feeUsdt = 0;
    if (grossUsdt <= 1000) {
      feeUsdt = 20;
    } else {
      feeUsdt = grossUsdt * 0.02;
    }
    const clientUsdt = grossUsdt - feeUsdt;
    return { grossUsdt, feeUsdt, clientUsdt };
  }

  // === Effective rates (API + / lub ręczne) ===
  const cryptoEffectiveRate = useMemo(() => {
    const manual = parseFloat(cryptoRate.replace(",", "."));
    if (useApiForCrypto && apiRates) {
      return apiRates[cryptoOutputCurrency];
    }
    if (!isNaN(manual) && manual > 0) return manual;
    if (apiRates) return apiRates[cryptoOutputCurrency];
    return 0;
  }, [cryptoRate, useApiForCrypto, apiRates, cryptoOutputCurrency]);

  const fiatEffectiveRate = useMemo(() => {
    const manual = parseFloat(fiatRate.replace(",", "."));
    if (useApiForFiat && apiRates) {
      return apiRates[fiatInputCurrency];
    }
    if (!isNaN(manual) && manual > 0) return manual;
    if (apiRates) return apiRates[fiatInputCurrency];
    return 0;
  }, [fiatRate, useApiForFiat, apiRates, fiatInputCurrency]);

  // === Kalkulator 1: z krypto na FIAT ===
  const cryptoCalc = useMemo(() => {
    const amount = parseFloat(cryptoAmount.replace(",", "."));
    const rate = cryptoEffectiveRate;
    if (!amount || !rate) {
      return { gross: 0, fee: 0, client: 0 };
    }
    const { grossFiat, feeFiat, clientFiat } = calcCryptoToFiat(amount, rate);
    return { gross: grossFiat, fee: feeFiat, client: clientFiat };
  }, [cryptoAmount, cryptoEffectiveRate]);

  // === Kalkulator 2: z FIAT na krypto ===
  const fiatCalc = useMemo(() => {
    const amount = parseFloat(fiatAmount.replace(",", "."));
    const rate = fiatEffectiveRate;
    if (!amount || !rate) {
      return { gross: 0, fee: 0, client: 0 };
    }
    const { grossUsdt, feeUsdt, clientUsdt } = calcFiatToCrypto(
      amount,
      rate
    );
    return { gross: grossUsdt, fee: feeUsdt, client: clientUsdt };
  }, [fiatAmount, fiatEffectiveRate]);

  // === AUTO-OBLICZANIE DLA FORMULARZA "НОВАЯ СДЕЛКА" ===
  useEffect(() => {
    const amount = parseFloat(newDeal.amountIn.replace(",", ".")) || 0;
    const rate = parseFloat(newDeal.rate.replace(",", ".")) || 0;

    const defaultPercent =
      parseFloat(dailyFeePercent.replace(",", ".")) || 0;
    const customPercent =
      newDeal.customPercent && newDeal.customPercent.trim() !== ""
        ? parseFloat(newDeal.customPercent.replace(",", "."))
        : null;

    // amountIn expressed in USDT for commission logic
    let amountInUsdt = amount;
    if (newDeal.amountInCurrency !== "USDT") {
      amountInUsdt = rate ? amount / rate : 0;
    }

    let commissionUsdt = parseFloat(commission.replace(",", ".")) || 0;

    // jeśli nie w trybie manualnym — przeliczamy automatycznie
    if (!isCommissionManual) {
      commissionUsdt = calculateAutoCommissionUsdt(
        amountInUsdt,
        defaultPercent,
        customPercent
      );
      setCommission(commissionUsdt ? commissionUsdt.toFixed(2) : "0.00");
    }

    // Oblicz ile klient otrzymuje (w walucie out)
    let clientGetsNum = 0;
    if (newDeal.amountOutCurrency === "USDT") {
      clientGetsNum = amountInUsdt - commissionUsdt;
    } else {
      clientGetsNum = (amountInUsdt - commissionUsdt) * rate;
    }

    setClientGets(Number.isFinite(clientGetsNum) ? clientGetsNum.toFixed(2) : "0.00");

    // Zaktualizuj pola formularza (amountOut i fee) — fee zawsze w USDT
    const feeStr = commissionUsdt ? commissionUsdt.toFixed(2) : "0.00";
    const amountOutStr = Number.isFinite(clientGetsNum) ? clientGetsNum.toFixed(2) : "0.00";

    setNewDeal((prev) => {
      if (prev.fee === feeStr && prev.amountOut === amountOutStr) return prev;
      return {
        ...prev,
        amountOut: amountOutStr,
        fee: feeStr,
        feeCurrency: "USDT",
      };
    });
  }, [
    newDeal.amountIn,
    newDeal.rate,
    dailyFeePercent,
    newDeal.customPercent,
    isCommissionManual,
  ]);

  // === Dodawanie transakcji ===
  const handleAddDeal = () => {
    if (!currentUser) {
      alert("Сначала войдите в систему.");
      return;
    }

    const amountInNum = parseFloat(newDeal.amountIn.replace(",", "."));
    const amountOutNum = parseFloat(newDeal.amountOut.replace(",", "."));
    const rateNum = newDeal.rate
      ? parseFloat(newDeal.rate.replace(",", "."))
      : undefined;

    if (!amountInNum || !amountOutNum) {
      alert("Wpisz poprawnie kwoty wejściową i wyjściową.");
      return;
    }

    // Final fee determined by commission state (manual or auto-calculated)
    const finalFee = parseFloat(commission.replace(",", ".")) || 0;

    const now = new Date();
    const deal: Deal = {
      id: `${Date.now()}`,
      time: formatTime(now),
      clientName: newDeal.clientName.trim(),
      telegram: newDeal.telegram.trim(),
      comment: newDeal.comment.trim(),
      amountIn: amountInNum,
      amountInCurrency: newDeal.amountInCurrency,
      amountOut: amountOutNum,
      amountOutCurrency: newDeal.amountOutCurrency,
      rate: rateNum,
      fee: finalFee,
      feeCurrency: "USDT",
      fromWallet: newDeal.fromWallet.trim(),
      toWallet: newDeal.toWallet.trim(),
      createdBy: currentUser.displayName,
      internalNote: newDealInternalNote.trim() || undefined,
    };

    setDealsByDate((prev) => {
      const dayDeals = prev[selectedDate] || [];
      return {
        ...prev,
        [selectedDate]: [...dayDeals, deal],
      };
    });

    setNewDeal((prev) => ({
      ...prev,
      clientName: "",
      telegram: "",
      comment: "",
      amountIn: "",
      amountOut: "",
      rate: "",
      fee: "",
      customPercent: "",
      fromWallet: "",
      toWallet: "",
    }));
    setNewDealInternalNote("");
  };

  const handleDeleteDeal = (id: string) => {
    setDealsByDate((prev) => {
      const dayDeals = prev[selectedDate] || [];
      return {
        ...prev,
        [selectedDate]: dayDeals.filter((d) => d.id !== id),
      };
    });
  };

  // Toggle selection for multi-delete
  const toggleDealSelection = (id: string) => {
    setSelectedDealIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  const handleDeleteSelectedDeals = () => {
    if (selectedDealIds.length === 0) return;
    setDealsByDate((prev) => {
      const dayDeals = prev[selectedDate] || [];
      const filtered = dayDeals.filter((d) => !selectedDealIds.includes(d.id));
      return {
        ...prev,
        [selectedDate]: filtered,
      };
    });
    setSelectedDealIds([]);
  };

  const handleDeleteAllDealsForDay = () => {
    if (!confirm("Удалить все сделки за этот день?")) return;
    setDealsByDate((prev) => ({ ...prev, [selectedDate]: [] }));
    setSelectedDealIds([]);
  };

  // Editing internal note for a single deal
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [editingNoteValue, setEditingNoteValue] = useState<string>("");
  const [editingNoteTags, setEditingNoteTags] = useState<string[]>([]);
  const [customTagInput, setCustomTagInput] = useState<string>("");

  const AVAILABLE_TAGS = ["важное", "проверить", "задержка", "проблема"];
  const TAG_COLORS: Record<string, string> = {
    "важное": "bg-red-500/20 border-red-500/50 text-red-300",
    "проверить": "bg-yellow-500/20 border-yellow-500/50 text-yellow-300",
    "задержка": "bg-orange-500/20 border-orange-500/50 text-orange-300",
    "проблема": "bg-purple-500/20 border-purple-500/50 text-purple-300",
  };

  const startEditNote = (dealId: string, current?: string, currentTags?: string[]) => {
    setEditingNoteId(dealId);
    setEditingNoteValue(current || "");
    setEditingNoteTags(currentTags || []);
    setCustomTagInput("");
  };

  const cancelEditNote = () => {
    setEditingNoteId(null);
    setEditingNoteValue("");
    setEditingNoteTags([]);
    setCustomTagInput("");
  };

  const toggleTag = (tag: string) => {
    setEditingNoteTags((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]
    );
  };

  const addCustomTag = () => {
    const trimmed = customTagInput.trim().toLowerCase();
    if (trimmed && !editingNoteTags.includes(trimmed)) {
      setEditingNoteTags((prev) => [...prev, trimmed]);
      setCustomTagInput("");
    }
  };

  const removeTag = (tag: string) => {
    setEditingNoteTags((prev) => prev.filter((t) => t !== tag));
  };

  const applyNoteTemplate = (template: string) => {
    setEditingNoteValue((prev) => (prev ? prev + "\n" + template : template));
  };

  const saveEditNote = () => {
    if (!editingNoteId) return;
    const newVal = editingNoteValue.trim();
    setDealsByDate((prev) => {
      const dayDeals = prev[selectedDate] || [];
      const updated = dayDeals.map((d) =>
        d.id === editingNoteId
          ? { ...d, internalNote: newVal || undefined, noteTags: editingNoteTags.length > 0 ? editingNoteTags : undefined }
          : d
      );
      return { ...prev, [selectedDate]: updated };
    });
    cancelEditNote();
  };

  // === Podsumowanie dnia ===
  const daySummary = useMemo(() => {
    const base = {
      PLN: { in: 0, out: 0, fee: 0 },
      EUR: { in: 0, out: 0, fee: 0 },
      USD: { in: 0, out: 0, fee: 0 },
      USDT: { in: 0, out: 0, fee: 0 },
    };

    for (const deal of currentDeals) {
      base[deal.amountInCurrency].in += deal.amountIn;
      base[deal.amountOutCurrency].out += deal.amountOut;
      base[deal.feeCurrency].fee += deal.fee;
    }

    const result = {} as Record<
      MoneyCurrency,
      { start: number; in: number; out: number; fee: number; end: number }
    >;

    (["PLN", "EUR", "USD", "USDT"] as MoneyCurrency[]).forEach((cur) => {
      const start = startBalances[cur];
      const info = base[cur];
      const end = start + info.in - info.out + info.fee;
      result[cur] = { start, in: info.in, out: info.out, fee: info.fee, end };
    });

    return result;
  }, [currentDeals, startBalances]);

  const handleBalanceChange = (currency: MoneyCurrency, value: string) => {
    const num = parseFloat(value.replace(",", ".") || "0");
    setStartBalances((prev) => ({ ...prev, [currency]: isNaN(num) ? 0 : num }));
  };

  // === EXPORT CSV dla bieżącej daty ===
  const exportDealsToCSV = () => {
    if (typeof window === "undefined") return;

    if (!currentDeals.length) {
      alert("На эту дату нет сделок для экспорта.");
      return;
    }

    const header = [
      "Date",
      "Time",
      "ClientName",
      "Telegram",
      "AmountIn",
      "CurrencyIn",
      "AmountOut",
      "CurrencyOut",
      "Rate",
      "Fee",
      "FeeCurrency",
      "FromWallet",
      "ToWallet",
      "Comment",
      "InternalNote",
      "NoteTags",
      "CreatedBy",
    ];

    const rows = currentDeals.map((deal) => {
      const safe = (value: string | number | undefined | null) => {
        if (value === undefined || value === null) return "";
        return String(value).replace(/"/g, '""');
      };

      return [
        selectedDate,
        deal.time,
        safe(deal.clientName),
        safe(deal.telegram),
        safe(deal.amountIn),
        deal.amountInCurrency,
        safe(deal.amountOut),
        deal.amountOutCurrency,
        deal.rate !== undefined ? safe(deal.rate) : "",
        safe(deal.fee),
        deal.feeCurrency,
        safe(deal.fromWallet),
        safe(deal.toWallet),
        safe(deal.comment),
        safe(deal.internalNote || ""),
        safe(deal.noteTags ? deal.noteTags.join(", ") : ""),
        safe(deal.createdBy || ""),
      ]
        .map((v) => `"${v}"`)
        .join(";");
    });

    const csvContent = [header.join(";"), ...rows].join("\n");
    const blob = new Blob([csvContent], {
      type: "text/csv;charset=utf-8;",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `smart-exchange-${selectedDate}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // === LOGIN SCREEN ===
  if (!currentUser) {
    return (
      <main className="min-h-screen bg-[#020817] text-white flex items-center justify-center px-4">
        <div className="w-full max-w-sm rounded-3xl border border-slate-800 bg-slate-950/80 p-6 shadow-xl">
          <h1 className="text-lg font-semibold mb-1">
            Smart Exchange — панель
          </h1>
          <p className="text-xs text-slate-400 mb-4">
            Вход только для операторов. Логины и пароли задаются владельцем
            системы.
          </p>

          <div className="space-y-3 text-xs">
            <div>
              <p className="text-slate-300 mb-1">Логин</p>
              <input
                className="w-full rounded-xl bg-black px-3 py-2 text-sm border border-slate-700 outline-none focus:border-emerald-400"
                value={loginForm.username}
                onChange={(e) =>
                  setLoginForm((p) => ({
                    ...p,
                    username: e.target.value,
                    error: "",
                  }))
                }
              />
            </div>
            <div>
              <p className="text-slate-300 mb-1">Пароль</p>
              <input
                type="password"
                className="w-full rounded-xl bg-black px-3 py-2 text-sm border border-slate-700 outline-none focus:border-emerald-400"
                value={loginForm.password}
                onChange={(e) =>
                  setLoginForm((p) => ({
                    ...p,
                    password: e.target.value,
                    error: "",
                  }))
                }
              />
            </div>

            {loginForm.error && (
              <p className="text-[11px] text-red-400">{loginForm.error}</p>
            )}

            <button
              onClick={handleLogin}
              className="mt-2 w-full rounded-full bg-emerald-500 py-2 text-sm font-semibold text-black hover:bg-emerald-400 transition"
            >
              Войти
            </button>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-[#020817] text-white">
      <div className="mx-auto max-w-6xl px-4 py-6">
        {/* TOP BAR */}
        <div className="mb-6 flex items-center justify-between gap-4 text-xs">
          <div className="text-slate-400">
            Залогован:
            <span className="ml-1 font-semibold text-slate-100">
              {currentUser.displayName}
            </span>
            <span className="ml-1 rounded-full border border-slate-600 px-2 py-0.5 text-[10px] uppercase text-slate-300">
              {currentUser.role === "admin" ? "admin" : "operator"}
            </span>
          </div>
          <div className="flex items-center gap-3">
            <div className="text-[11px] text-slate-400">
              API:{" "}
              {apiStatus === "loading" && (
                <span className="text-amber-300">обновление...</span>
              )}
              {apiStatus === "ok" && apiRates && (
                <span className="text-emerald-300">
                  1 USDT = {apiRates.PLN.toFixed(2)} PLN /{" "}
                  {apiRates.EUR.toFixed(3)} EUR / {apiRates.USD.toFixed(3)} USD
                  {lastApiUpdate && (
                    <span className="text-slate-500">
                      {" "}
                      (обновлено: {lastApiUpdate})
                    </span>
                  )}
                </span>
              )}
              {apiStatus === "error" && (
                <span className="text-red-400">
                  ошибка API, используем ручные курсы
                </span>
              )}
            </div>
            <button
              onClick={handleLogout}
              className="rounded-full border border-slate-600 px-3 py-1 text-[11px] text-slate-200 hover:bg-slate-800"
            >
              Выйти
            </button>
          </div>
        </div>

        {/* HERO + KALKULATOR */}
        <section className="mb-12 grid gap-10 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)] items-start">
          <div>
            <p className="text-sm tracking-[0.25em] text-teal-300 uppercase mb-4">
              ИНТЕЛЛЕКТУАЛЬНАЯ БИРЖА • ЧАСТНОЕ БЮРО
            </p>
            <h1 className="text-4xl sm:text-5xl lg:text-5xl font-bold leading-tight mb-4">
              Обмен криптовалюты как в банке,
              <br />
              <span className="text-emerald-400">но только для избранных.</span>
            </h1>
            <p className="text-sm text-slate-300 max-w-xl mt-4">
              Калькулятор может брать курс с рынка (API) или по вашим ручным
              параметрам. Правила комиссии и условия сделки определяете вы, не
              биржа.
            </p>

            <div className="mt-8 grid gap-4 sm:grid-cols-3 text-xs text-slate-300">
              <div className="rounded-2xl border border-slate-700/70 bg-slate-900/40 px-4 py-3">
                <p className="text-[11px] font-semibold text-slate-400 uppercase mb-1">
                  Безопасность
                </p>
                <p>Вход только по логину, можно добавить VPN и 2FA.</p>
              </div>
              <div className="rounded-2xl border border-slate-700/70 bg-slate-900/40 px-4 py-3">
                <p className="text-[11px] font-semibold text-slate-400 uppercase mb-1">
                  Комиссии
                </p>
                <p>Пороговые правила + индивидуальный % для VIP.</p>
              </div>
              <div className="rounded-2xl border border-slate-700/70 bg-slate-900/40 px-4 py-3">
                <p className="text-[11px] font-semibold text-slate-400 uppercase mb-1">
                  Контроль
                </p>
                <p>Каждая сделка привязана к конкретному оператору.</p>
              </div>
            </div>
          </div>

          {/* KALKULATOR */}
          <div className="rounded-3xl border border-emerald-500/40 bg-slate-900/60 shadow-[0_0_60px_rgba(16,185,129,0.35)] overflow-hidden">
            <div className="flex items-center justify-between px-6 pt-5 pb-3 text-xs text-slate-300">
              <span className="font-semibold">
                Калькулятор обмена (онлайн / демо)
              </span>
              <span className="rounded-full border border-emerald-400/60 px-3 py-1 text-[11px] text-emerald-300">
                LIVE / DEMO
              </span>
            </div>

            <div className="px-4">
              <div className="mx-1 mb-4 flex rounded-full bg-slate-900/70 p-1 text-xs">
                <button
                  onClick={() => setActiveTab("cryptoToFiat")}
                  className={`flex-1 rounded-full px-3 py-2 font-semibold transition ${
                    activeTab === "cryptoToFiat"
                      ? "bg-emerald-500 text-black"
                      : "text-slate-300"
                  }`}
                >
                  Из крипто → FIAT
                </button>
                <button
                  onClick={() => setActiveTab("fiatToCrypto")}
                  className={`flex-1 rounded-full px-3 py-2 font-semibold transition ${
                    activeTab === "fiatToCrypto"
                      ? "bg-emerald-500 text-black"
                      : "text-slate-300"
                  }`}
                >
                  Из FIAT → крипто
                </button>
              </div>
            </div>

            {/* KALK 1 */}
            {activeTab === "cryptoToFiat" && (
              <div className="px-6 pb-6 space-y-3 text-xs">
                <div>
                  <p className="mb-1 text-slate-300">У вас есть</p>
                  <div className="flex gap-2">
                    <input
                      className="w-full rounded-xl bg-black px-3 py-2 text-sm outline-none border border-slate-700 focus:border-emerald-400"
                      value={cryptoAmount}
                      onChange={(e) => setCryptoAmount(e.target.value)}
                    />
                    <select
                      className="w-28 rounded-xl bg-black px-3 py-2 text-sm border border-slate-700"
                      value="USDT"
                      disabled
                    >
                      <option>USDT</option>
                    </select>
                  </div>
                </div>

                <div>
                  <p className="mb-1 text-slate-300">
                    Клиент хочет получить в валюте
                  </p>
                  <select
                    className="w-full rounded-xl bg-black px-3 py-2 text-sm border border-slate-700"
                    value={cryptoOutputCurrency}
                    onChange={(e) =>
                      setCryptoOutputCurrency(
                        e.target.value as FiatCurrency
                      )
                    }
                  >
                    <option value="PLN">PLN — Польский злотый</option>
                    <option value="EUR">EUR — Евро</option>
                    <option value="USD">USD — Доллар</option>
                  </select>
                </div>

                <div>
                  <p className="mb-1 text-slate-300">
                    Курс 1 USDT в {cryptoOutputCurrency}
                  </p>
                  <input
                    className={`w-full rounded-xl px-3 py-2 text-sm outline-none border ${
                      useApiForCrypto && apiRates
                        ? "bg-slate-900 border-slate-700 opacity-70 cursor-not-allowed"
                        : "bg-black border-slate-700 focus:border-emerald-400"
                    }`}
                    value={
                      useApiForCrypto && apiRates
                        ? cryptoEffectiveRate.toFixed(4)
                        : cryptoRate
                    }
                    onChange={(e) => setCryptoRate(e.target.value)}
                    readOnly={useApiForCrypto && !!apiRates}
                  />
                  <div className="mt-1 flex items-center justify-between gap-2">
                    <label className="inline-flex items-center gap-2 text-[11px] text-slate-400">
                      <input
                        type="checkbox"
                        className="h-3 w-3 rounded border-slate-600 bg-black"
                        checked={useApiForCrypto}
                        onChange={(e) =>
                          setUseApiForCrypto(e.target.checked)
                        }
                      />
                      <span>Использовать курс с рынка (API)</span>
                    </label>
                    <span className="text-[11px] text-slate-500">
                      Рынок:{" "}
                      {apiRates
                        ? apiRates[cryptoOutputCurrency].toFixed(4)
                        : "—"}
                    </span>
                  </div>
                </div>

                <div className="mt-3 rounded-2xl bg-slate-950/60 px-4 py-3 text-xs border border-slate-800">
                  <div className="flex justify-between">
                    <span className="text-slate-400">Брутто-сумма</span>
                    <span className="font-medium">
                      {formatMoney(
                        cryptoCalc.gross,
                        cryptoOutputCurrency
                      )}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">Комиссия / бонус</span>
                    <span
                      className={
                        cryptoCalc.fee < 0 ? "text-emerald-400" : "text-orange-300"
                      }
                    >
                      {cryptoCalc.fee === 0
                        ? "0"
                        : formatMoney(
                            cryptoCalc.fee,
                            cryptoOutputCurrency
                          )}
                    </span>
                  </div>
                  <div className="mt-1 h-px bg-slate-800" />
                  <div className="mt-1 flex justify-between font-semibold">
                    <span className="">Клиент получит</span>
                    <span className="text-emerald-400">
                      {formatMoney(
                        cryptoCalc.client,
                        cryptoOutputCurrency
                      )}
                    </span>
                  </div>
                </div>
              </div>
            )}

            {/* KALK 2 */}
            {activeTab === "fiatToCrypto" && (
              <div className="px-6 pb-6 space-y-3 text-xs">
                <div>
                  <p className="mb-1 text-slate-300">Клиент отдаёт (FIAT)</p>
                  <div className="flex gap-2">
                    <input
                      className="w-full rounded-xl bg-black px-3 py-2 text-sm outline-none border border-slate-700 focus:border-emerald-400"
                      value={fiatAmount}
                      onChange={(e) => setFiatAmount(e.target.value)}
                    />
                    <select
                      className="w-28 rounded-xl bg-black px-3 py-2 text-sm border border-slate-700"
                      value={fiatInputCurrency}
                      onChange={(e) =>
                        setFiatInputCurrency(
                          e.target.value as FiatCurrency
                        )
                      }
                    >
                      <option value="PLN">PLN</option>
                      <option value="EUR">EUR</option>
                      <option value="USD">USD</option>
                    </select>
                  </div>
                </div>

                <div>
                  <p className="mb-1 text-slate-300">
                    Курс 1 USDT в {fiatInputCurrency}
                  </p>
                  <input
                    className={`w-full rounded-xl px-3 py-2 text-sm outline-none border ${
                      useApiForFiat && apiRates
                        ? "bg-slate-900 border-slate-700 opacity-70 cursor-not-allowed"
                        : "bg-black border-slate-700 focus:border-emerald-400"
                    }`}
                    value={
                      useApiForFiat && apiRates
                        ? fiatEffectiveRate.toFixed(4)
                        : fiatRate
                    }
                    onChange={(e) => setFiatRate(e.target.value)}
                    readOnly={useApiForFiat && !!apiRates}
                  />
                  <div className="mt-1 flex items-center justify-between gap-2">
                    <label className="inline-flex items-center gap-2 text-[11px] text-slate-400">
                      <input
                        type="checkbox"
                        className="h-3 w-3 rounded border-slate-600 bg-black"
                        checked={useApiForFiat}
                        onChange={(e) =>
                          setUseApiForFiat(e.target.checked)
                        }
                      />
                      <span>Использовать курс с рынка (API)</span>
                    </label>
                    <span className="text-[11px] text-slate-500">
                      Рынок:{" "}
                      {apiRates
                        ? apiRates[fiatInputCurrency].toFixed(4)
                        : "—"}
                    </span>
                  </div>
                </div>

                <div className="mt-3 rounded-2xl bg-slate-950/60 px-4 py-3 text-xs border border-slate-800">
                  <div className="flex justify-between">
                    <span className="text-slate-400">Брутто (USDT)</span>
                    <span className="font-medium">
                      {formatMoney(fiatCalc.gross, "USDT")}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">Комиссия (USDT)</span>
                    <span className="text-orange-300">
                      {formatMoney(fiatCalc.fee, "USDT")}
                    </span>
                  </div>
                  <div className="mt-1 h-px bg-slate-800" />
                  <div className="mt-1 flex justify-between font-semibold">
                    <span className="">Клиент получит</span>
                    <span className="text-emerald-400">
                      {formatMoney(fiatCalc.client, "USDT")}
                    </span>
                  </div>
                </div>
              </div>
            )}
          </div>
        </section>

        {/* --- START BALANCE --- tylko dla adminów */}
        {currentUser.role === "admin" && (
          <section className="mb-10 rounded-3xl border border-slate-800 bg-slate-950/60 px-6 py-5 text-xs">
            <h2 className="mb-3 text-sm font-semibold">
              Стартовый баланс дня (касса / кошельки)
            </h2>
            <div className="grid gap-3 sm:grid-cols-4">
              {(["PLN", "EUR", "USD", "USDT"] as MoneyCurrency[]).map((cur) => (
                <div key={cur} className="space-y-1">
                  <p className="text-slate-300">{cur}</p>
                  <input
                    className="w-full rounded-xl bg-black px-3 py-2 text-sm border border-slate-700"
                    value={startBalances[cur].toString().replace(".", ",")}
                    onChange={(e) => handleBalanceChange(cur, e.target.value)}
                  />
                </div>
              ))}
            </div>
          </section>
        )}

        {/* --- USTAWIENIA DNIA --- */}
        <section className="mb-10 rounded-3xl border border-slate-800 bg-slate-950/60 px-6 py-5 text-xs">
          <h2 className="mb-3 text-sm font-semibold">Настройки дня</h2>
          <p className="mb-4 text-slate-300">Процент комиссии на сегодня по умолчанию</p>
          <div className="flex gap-2 items-end max-w-sm">
            <div className="flex-1">
              <input
                type="number"
                className="w-full rounded-xl bg-black px-3 py-2 text-sm border border-slate-700 outline-none focus:border-emerald-400"
                placeholder="1.0"
                value={dailyFeePercent}
                onChange={(e) => {
                  setDailyFeePercent(e.target.value);
                  const todayKey = TODAY_KEY();
                  const storageKey = `daily-commission-${todayKey}`;
                  if (e.target.value.trim()) {
                    window.localStorage.setItem(storageKey, e.target.value);
                  } else {
                    window.localStorage.removeItem(storageKey);
                  }
                }}
              />
            </div>
            <p className="text-slate-300">%</p>
          </div>
        </section>

        {/* --- NOWA TRANSAKCJA --- */}
        <section className="mb-10 rounded-3xl border border-slate-800 bg-slate-950/60 px-6 py-5 text-xs">
          <h2 className="mb-4 text-sm font-semibold">
            Новая сделка (оператор: {currentUser.displayName})
          </h2>

          <div className="grid gap-4 md:grid-cols-3">
            <div className="space-y-2">
              <p className="text-slate-300">Имя клиента</p>
              <div className="relative">
                <input
                  className="w-full rounded-xl bg-black px-3 py-2 text-sm border border-slate-700"
                  value={newDeal.clientName}
                  onChange={(e) =>
                    setNewDeal((p) => ({ ...p, clientName: e.target.value }))
                  }
                  placeholder="Введите имя или выберите из списка"
                />
                {newDeal.clientName && (
                  <div className="absolute top-full left-0 right-0 mt-1 bg-slate-900 border border-slate-700 rounded-xl z-10 max-h-32 overflow-y-auto">
                    {uniqueClients
                      .filter((c) =>
                        c.toLowerCase().includes(newDeal.clientName.toLowerCase())
                      )
                      .slice(0, 5)
                      .map((c) => (
                        <button
                          key={c}
                          type="button"
                          onClick={() =>
                            setNewDeal((p) => ({ ...p, clientName: c }))
                          }
                          className="block w-full px-3 py-2 text-left text-sm text-slate-300 hover:bg-slate-800"
                        >
                          {c}
                        </button>
                      ))}
                  </div>
                )}
              </div>

              <p className="mt-3 text-slate-300">
                Username в Telegram (например, @cryptoMax)
              </p>
              <div className="relative">
                <input
                  className="w-full rounded-xl bg-black px-3 py-2 text-sm border border-slate-700"
                  value={newDeal.telegram}
                  onChange={(e) =>
                    setNewDeal((p) => ({ ...p, telegram: e.target.value }))
                  }
                  placeholder="Введите или выберите"
                />
                {newDeal.telegram && (
                  <div className="absolute top-full left-0 right-0 mt-1 bg-slate-900 border border-slate-700 rounded-xl z-10 max-h-32 overflow-y-auto">
                    {uniqueTelegramAccounts
                      .filter((t) =>
                        t.toLowerCase().includes(newDeal.telegram.toLowerCase())
                      )
                      .slice(0, 5)
                      .map((t) => (
                        <button
                          key={t}
                          type="button"
                          onClick={() =>
                            setNewDeal((p) => ({ ...p, telegram: t }))
                          }
                          className="block w-full px-3 py-2 text-left text-sm text-slate-300 hover:bg-slate-800"
                        >
                          {t}
                        </button>
                      ))}
                  </div>
                )}
              </div>

              <p className="mt-3 text-slate-300">
                Хэш / комментарий (из какого кошелька → на какой)
              </p>
              <textarea
                rows={4}
                className="w-full rounded-xl bg-black px-3 py-2 text-sm border border-slate-700 resize-none"
                value={newDeal.comment}
                onChange={(e) =>
                  setNewDeal((p) => ({ ...p, comment: e.target.value }))
                }
              />
              <p className="mt-3 text-slate-300">Внутренняя заметка (для себя)</p>
              <textarea
                rows={3}
                className="w-full rounded-xl bg-black px-3 py-2 text-sm border border-slate-700 resize-none"
                placeholder="Короткая заметка оператора..."
                value={newDealInternalNote}
                onChange={(e) => setNewDealInternalNote(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <p className="text-slate-300">Клиент отдаёт (входит к вам)</p>
              <div className="flex gap-2">
                <input
                  className="w-full rounded-xl bg-black px-3 py-2 text-sm border border-slate-700"
                  value={newDeal.amountIn}
                  onChange={(e) =>
                    setNewDeal((p) => ({ ...p, amountIn: e.target.value }))
                  }
                />
                <select
                  className="w-24 rounded-xl bg-black px-2 py-2 text-sm border border-slate-700"
                  value={newDeal.amountInCurrency}
                  onChange={(e) =>
                    setNewDeal((p) => ({
                      ...p,
                      amountInCurrency: e.target.value as MoneyCurrency,
                    }))
                  }
                >
                  <option value="PLN">PLN</option>
                  <option value="EUR">EUR</option>
                  <option value="USD">USD</option>
                  <option value="USDT">USDT</option>
                </select>
              </div>

              <p className="mt-3 text-slate-300">Курс сделки</p>
              <input
                className="w-full rounded-xl bg-black px-3 py-2 text-sm border border-slate-700"
                placeholder="Например: 4,25 (1 USDT = 4,25 PLN)"
                value={newDeal.rate}
                onChange={(e) =>
                  setNewDeal((p) => ({ ...p, rate: e.target.value }))
                }
              />
              <button
                type="button"
                onClick={() => {
                  if (!apiRates) return;
                  let targetFiat: FiatCurrency | null = null;
                  if (newDeal.amountInCurrency === "USDT") {
                    if (newDeal.amountOutCurrency !== "USDT") {
                      targetFiat = newDeal
                        .amountOutCurrency as FiatCurrency;
                    }
                  } else if (newDeal.amountOutCurrency === "USDT") {
                    targetFiat = newDeal.amountInCurrency as FiatCurrency;
                  }
                  if (!targetFiat) return;
                  const r = apiRates[targetFiat];
                  if (!r) return;
                  setNewDeal((p) => ({
                    ...p,
                    rate: r.toString().replace(".", ","),
                  }));
                }}
                className="mt-1 rounded-full border border-emerald-400/60 px-3 py-1 text-[11px] text-emerald-300 hover:bg-emerald-500/10"
              >
                Подставить курс с рынка (API)
              </button>

              <p className="mt-3 text-slate-300">
                Процент комиссии, % (опционально)
              </p>
              <input
                className="w-full rounded-xl bg-black px-3 py-2 text-sm border border-slate-700"
                placeholder="Оставьте пустым для стандартных правил"
                value={newDeal.customPercent}
                onChange={(e) =>
                  setNewDeal((p) => ({ ...p, customPercent: e.target.value }))
                }
              />
              <p className="text-[11px] text-slate-500">
                Если здесь указать число (например 1,5 или 0), стандартные
                шаблоны комиссии будут игнорироваться для этой сделки.
              </p>
            </div>

            <div className="space-y-2">
              <p className="text-slate-300">Клиент получает (вы отдаёте)</p>
              <div className="flex gap-2">
                <input
                  className="w-full rounded-xl bg-black px-3 py-2 text-sm border border-slate-700"
                  value={newDeal.amountOut}
                  onChange={(e) =>
                    setNewDeal((p) => ({ ...p, amountOut: e.target.value }))
                  }
                />
                <select
                  className="w-24 rounded-xl bg-black px-2 py-2 text-sm border border-slate-700"
                  value={newDeal.amountOutCurrency}
                  onChange={(e) =>
                    setNewDeal((p) => ({
                      ...p,
                      amountOutCurrency: e.target.value as MoneyCurrency,
                    }))
                  }
                >
                  <option value="PLN">PLN</option>
                  <option value="EUR">EUR</option>
                  <option value="USD">USD</option>
                  <option value="USDT">USDT</option>
                </select>
              </div>

              <p className="mt-3 text-slate-300">
                Комиссия / бонус (в вашу пользу)
              </p>
              <div className="flex gap-2">
                <input
                  className="w-full rounded-xl bg-black px-3 py-2 text-sm border border-slate-700"
                  value={commission}
                  onChange={(e) => {
                    const value = e.target.value;
                    setCommission(value);
                    setIsCommissionManual(value !== "");
                    // If user cleared the commission, revert to auto mode
                    if (value === "") setIsCommissionManual(false);
                  }}
                />
                <select
                  className="w-24 rounded-xl bg-black px-2 py-2 text-sm border border-slate-700 opacity-70 cursor-not-allowed"
                  value="USDT"
                  disabled
                >
                  <option value="USDT">USDT</option>
                </select>
              </div>
              <p className="text-[11px] text-slate-500">
                Если это бонус от вас клиенту — можно указать сумму со знаком
                «-» и добавить пояснение в комментарии.
              </p>

              <p className="mt-3 text-slate-300">Из кошелька</p>
              <input
                className="w-full rounded-xl bg-black px-3 py-2 text-sm border border-slate-700"
                value={newDeal.fromWallet}
                onChange={(e) =>
                  setNewDeal((p) => ({ ...p, fromWallet: e.target.value }))
                }
              />

              <p className="mt-3 text-slate-300">В кошелёк</p>
              <input
                className="w-full rounded-xl bg-black px-3 py-2 text-sm border border-slate-700"
                value={newDeal.toWallet}
                onChange={(e) =>
                  setNewDeal((p) => ({ ...p, toWallet: e.target.value }))
                }
              />

              <button
                onClick={handleAddDeal}
                className="mt-4 w-full rounded-full bg-emerald-500 py-2 text-sm font-semibold text-black hover:bg-emerald-400 transition"
              >
                Добавить сделку в отчёт дня
              </button>
            </div>
          </div>
        </section>

        {/* --- LISTA TRANSAKCJI --- */}
        <section className="mb-8 rounded-3xl border border-slate-800 bg-slate-950/80 px-6 py-5 text-xs">
          <div className="mb-3 flex flex-col gap-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <input
                  type="date"
                  className="rounded-xl bg-black px-3 py-2 text-sm border border-slate-700"
                  value={selectedDate}
                  onChange={(e) => {
                    setSelectedDate(e.target.value);
                    setSelectedDealIds([]);
                  }}
                />
                <button
                  onClick={() => {
                    const t = TODAY_KEY();
                    setSelectedDate(t);
                    setSelectedDealIds([]);
                  }}
                  className="rounded-full border border-slate-700 px-3 py-1 text-[11px] text-slate-200 hover:bg-slate-800"
                >
                  Сегодня
                </button>
              </div>
              <div />
            </div>

            {/* Mini calendar / date pills based on dealsByDate */}
            <div className="flex gap-2 overflow-x-auto pb-1">
              {allDates.length === 0 ? (
                <div className="text-slate-500 text-[11px]">Нет дат с сделками</div>
              ) : (
                allDates.map((dateKey) => {
                  const count = dealsByDate[dateKey]?.length ?? 0;
                  const isSelected = dateKey === selectedDate;
                  return (
                    <button
                      key={dateKey}
                      onClick={() => {
                        setSelectedDate(dateKey);
                        setSelectedDealIds([]);
                      }}
                      className={`flex items-center gap-2 whitespace-nowrap rounded-full px-3 py-1 text-xs transition ${
                        isSelected
                          ? "bg-emerald-500 text-black border border-emerald-400"
                          : "bg-slate-800 text-slate-300 border border-slate-700"
                      }`}
                    >
                      <span>{dateKey}{count > 0 ? ` (${count})` : ""}</span>
                      {count > 0 && (
                        <span className="h-2 w-2 rounded-full bg-emerald-400 inline-block" />
                      )}
                    </button>
                  );
                })
              )}
            </div>

            <div>
              <p className="text-slate-400 text-[11px] mb-1">Заметка на день</p>
              <textarea
                rows={3}
                className="w-full rounded-xl bg-black px-3 py-2 text-sm border border-slate-700 resize-none"
                placeholder="Короткая заметка для этой даты..."
                value={currentNote}
                onChange={(e) =>
                  setDayNotes((p) => ({ ...p, [selectedDate]: e.target.value }))
                }
              />
            </div>
          </div>

          <div className="mb-3 flex items-center justify-between gap-2">
            <div className="flex items-center gap-3">
              <h2 className="text-sm font-semibold">
                Сделки за {selectedDate}
              </h2>
              <span className="text-slate-400">
                Количество: {currentDeals.length}
              </span>
            </div>
            <button
              onClick={exportDealsToCSV}
              className="rounded-full border border-emerald-400/60 px-3 py-1 text-[11px] font-medium text-emerald-300 hover:bg-emerald-500/10"
            >
              Экспорт в CSV
            </button>
          </div>

          <div className="mb-3 flex items-center gap-2">
            <button
              onClick={handleDeleteSelectedDeals}
              className="rounded-full border border-red-500/60 px-3 py-1 text-[11px] font-medium text-red-300 hover:bg-red-500/10"
            >
              Удалить выбранные сделки
            </button>
            <button
              onClick={handleDeleteAllDealsForDay}
              className="rounded-full border border-red-600/60 px-3 py-1 text-[11px] font-medium text-red-300 hover:bg-red-600/10"
            >
              Удалить все сделки за день
            </button>
          </div>

          {currentDeals.length === 0 ? (
            <p className="text-slate-500">На эту дату ещё нет сделок.</p>
          ) : (
            <div className="space-y-3">
              {currentDeals.map((deal) => (
                <div
                  key={deal.id}
                  className="rounded-2xl border border-slate-800 bg-slate-900/80 px-4 py-3"
                >
                  <div className="flex items-center justify-between gap-2">
                    <input
                      type="checkbox"
                      checked={selectedDealIds.includes(deal.id)}
                      onChange={() => toggleDealSelection(deal.id)}
                      className="h-4 w-4"
                    />
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded-full bg-slate-800 px-2 py-0.5 text-[11px] text-slate-300">
                        {deal.time}
                      </span>
                      {deal.clientName && (
                        <span className="font-semibold">
                          {deal.clientName}
                        </span>
                      )}
                      {deal.telegram && (
                        <span className="text-slate-400">
                          @{deal.telegram.replace(/^@/, "")}
                        </span>
                      )}
                      {deal.createdBy && (
                        <span className="rounded-full bg-slate-800/80 px-2 py-0.5 text-[10px] text-emerald-300">
                          Оператор: {deal.createdBy}
                        </span>
                      )}
                    </div>
                    <button
                      onClick={() => handleDeleteDeal(deal.id)}
                      className="rounded-full border border-red-500/60 px-3 py-1 text-[11px] text-red-300 hover:bg-red-500/10"
                    >
                      Удалить
                    </button>
                  </div>

                  <div className="mt-1 text-[11px] text-slate-300">
                    Клиент отдаёт:{" "}
                    <span className="font-medium">
                      {formatMoney(deal.amountIn, deal.amountInCurrency)}
                    </span>{" "}
                    → получает:{" "}
                    <span className="font-medium">
                      {formatMoney(deal.amountOut, deal.amountOutCurrency)}
                    </span>
                  </div>

                  <div className="mt-1 text-[11px] text-slate-300">
                    Комиссия:{" "}
                    <span className="text-amber-300">
                        {formatMoney(deal.fee, "USDT")}
                    </span>
                  </div>

                  {deal.rate && (
                    <div className="mt-1 text-[11px] text-slate-400">
                      Курс сделки: 1 USDT = {deal.rate.toFixed(4)}{" "}
                      {deal.amountInCurrency === "USDT"
                        ? deal.amountOutCurrency
                        : deal.amountInCurrency}
                    </div>
                  )}

                  {deal.comment && (
                    <div className="mt-1 text-[11px] text-slate-400">
                      Примечание: {deal.comment}
                    </div>
                  )}

                  {/* internal note display / edit */}
                  {editingNoteId === deal.id ? (
                    <div className="mt-3 border-t border-slate-800 pt-3">
                      <p className="text-[11px] text-slate-400 mb-2">Шаблоны заметок:</p>
                      <div className="flex flex-wrap gap-2 mb-3">
                        {["Задержка", "Проблема с курсом", "Ожидание подтверждения"].map((template) => (
                          <button
                            key={template}
                            type="button"
                            onClick={() => applyNoteTemplate(template)}
                            className="rounded-full border border-slate-700 px-2 py-1 text-[10px] text-slate-300 hover:bg-slate-800"
                          >
                            + {template}
                          </button>
                        ))}
                      </div>

                      <textarea
                        rows={3}
                        className="w-full rounded-xl bg-black px-3 py-2 text-sm border border-slate-700 resize-none mb-2"
                        value={editingNoteValue}
                        onChange={(e) => setEditingNoteValue(e.target.value)}
                      />

                      <p className="text-[11px] text-slate-400 mb-2">Теги:</p>
                      <div className="flex flex-wrap gap-2 mb-3">
                        {AVAILABLE_TAGS.map((tag) => (
                          <button
                            key={tag}
                            type="button"
                            onClick={() => toggleTag(tag)}
                            className={`rounded-full border px-3 py-1 text-[11px] transition ${
                              editingNoteTags.includes(tag)
                                ? TAG_COLORS[tag]
                                : "border-slate-700 text-slate-400 hover:border-slate-600"
                            }`}
                          >
                            {editingNoteTags.includes(tag) ? "✓ " : ""}{tag}
                          </button>
                        ))}
                      </div>

                      {/* Выбранные теги и возможность удаления */}
                      {editingNoteTags.length > 0 && (
                        <div className="mb-3 p-2 bg-slate-800/30 rounded-lg">
                          <p className="text-[10px] text-slate-400 mb-1">Выбранные теги:</p>
                          <div className="flex flex-wrap gap-1">
                            {editingNoteTags.map((tag) => (
                              <div
                                key={tag}
                                className={`rounded-full border px-2 py-0.5 text-[10px] flex items-center gap-1 ${
                                  TAG_COLORS[tag] || "bg-slate-700/50 border-slate-600 text-slate-300"
                                }`}
                              >
                                {tag}
                                <button
                                  type="button"
                                  onClick={() => removeTag(tag)}
                                  className="ml-1 font-bold hover:opacity-70"
                                >
                                  ×
                                </button>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Добавить свой тег */}
                      <div className="mb-3">
                        <p className="text-[11px] text-slate-400 mb-1">Добавить свой тег:</p>
                        <div className="flex gap-2">
                          <input
                            type="text"
                            className="flex-1 rounded-lg bg-black px-2 py-1 text-sm border border-slate-700"
                            placeholder="Введите новый тег"
                            value={customTagInput}
                            onChange={(e) => setCustomTagInput(e.target.value)}
                            onKeyPress={(e) => {
                              if (e.key === "Enter") {
                                addCustomTag();
                              }
                            }}
                          />
                          <button
                            type="button"
                            onClick={addCustomTag}
                            className="rounded-lg border border-emerald-500/50 px-2 py-1 text-[11px] text-emerald-300 hover:bg-emerald-500/10"
                          >
                            Добавить
                          </button>
                        </div>
                      </div>

                      <div className="flex gap-2">
                        <button
                          onClick={saveEditNote}
                          className="rounded-full bg-emerald-500 px-3 py-1 text-[12px] text-black"
                        >
                          Сохранить заметку
                        </button>
                        <button
                          onClick={cancelEditNote}
                          className="rounded-full border border-slate-700 px-3 py-1 text-[12px] text-slate-300"
                        >
                          Отмена
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="mt-2 border-t border-slate-800 pt-2">
                      {deal.internalNote ? (
                        <div className="text-[11px] text-slate-400 mb-2">Заметка: {deal.internalNote}</div>
                      ) : (
                        <div className="text-[11px] text-slate-500 mb-2">Нет заметки</div>
                      )}
                      {deal.noteTags && deal.noteTags.length > 0 && (
                        <div className="flex flex-wrap gap-1 mb-2">
                          {deal.noteTags.map((tag) => (
                            <span key={tag} className={`rounded-full border px-2 py-0.5 text-[10px] ${TAG_COLORS[tag]}`}>
                              {tag}
                            </span>
                          ))}
                        </div>
                      )}
                      <button
                        onClick={() => startEditNote(deal.id, deal.internalNote, deal.noteTags)}
                        className="rounded-full border border-slate-700 px-3 py-1 text-[11px] text-slate-200 hover:bg-slate-800"
                      >
                        {deal.internalNote ? "Редактировать заметку" : "Добавить заметку"}
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>

        {/* --- PODSUMOWANIE DNIA --- */}
        <section className="mb-10 rounded-3xl border border-slate-800 bg-slate-950/90 px-6 py-5 text-xs">
          <h2 className="mb-3 text-sm font-semibold">Итоги дня</h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {(["PLN", "EUR", "USD", "USDT"] as MoneyCurrency[]).map((cur) => {
              const s = daySummary[cur];
              const formatter = new Intl.NumberFormat("pl-PL", {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              });
              const fmt = (v: number) => formatter.format(v);

              return (
                <div
                  key={cur}
                  className="rounded-2xl border border-slate-800 bg-slate-900/80 px-4 py-3"
                >
                  <p className="text-[11px] font-semibold text-slate-400 uppercase mb-1">
                    {cur}
                  </p>
                  <p className="text-[11px] text-slate-300">
                    Старт:{" "}
                    <span className="font-medium">{fmt(s.start)}</span>
                  </p>
                  <p className="text-[11px] text-emerald-300">
                    + Пришло:{" "}
                    <span className="font-medium">{fmt(s.in)}</span>
                  </p>
                  <p className="text-[11px] text-rose-300">
                    − Ушло:{" "}
                    <span className="font-medium">{fmt(s.out)}</span>
                  </p>
                  <p className="text-[11px] text-amber-300">
                    Профит (комиссии):{" "}
                    <span className="font-medium">{fmt(s.fee)}</span>
                  </p>
                  <div className="mt-1 h-px bg-slate-800" />
                  <p className="mt-1 text-[11px] text-slate-100">
                    Итог:{" "}
                    <span className="font-semibold text-emerald-400">
                      {fmt(s.end)}
                    </span>
                  </p>
                </div>
              );
            })}
          </div>

          <p className="mt-3 text-[11px] text-slate-500">
            Итог считается по формуле: старт + принято − выдано + комиссии.
            Комиссия считается отдельно по каждой валюте.
          </p>
        </section>

        <footer className="pb-6 text-[11px] text-slate-500 text-center">
          © {new Date().getFullYear()} Smart Exchange — Dasha &amp; Pasha
        </footer>
      </div>
    </main>
  );
}