'use client'

import { useEffect, useState } from 'react'

export default function AdminPage() {
  const [authorized, setAuthorized] = useState(false)
  const [password, setPassword] = useState('')

  const [form, setForm] = useState({
    name: '',
    telegram: '',
    fromWallet: '',
    toWallet: '',
    fromAmount: '',
    fromCurrency: 'USDT',
    toAmount: '',
    toCurrency: 'PLN',
    fee: '',
    note: ''
  })

  const [transactions, setTransactions] = useState<any[]>([])

  const today = new Date().toISOString().slice(0, 10)

  // ✅ LOGIN
  const handleLogin = () => {
    if (password === process.env.NEXT_PUBLIC_ADMIN_PASSWORD) {
      setAuthorized(true)
    } else {
      alert('Nieprawidłowe hasło')
    }
  }

  // ✅ POBRANIE Z localStorage
  useEffect(() => {
    const stored = localStorage.getItem('transactions_' + today)
    if (stored) {
      setTransactions(JSON.parse(stored))
    }
  }, [])

  // ✅ ZAPIS DO localStorage
  const saveTransactions = (data: any[]) => {
    setTransactions(data)
    localStorage.setItem('transactions_' + today, JSON.stringify(data))
  }

  // ✅ DODAJ TRANSAKCJĘ
  const addTransaction = () => {
    if (!form.name || !form.fromAmount || !form.toAmount) {
      alert('Uzupełnij wymagane pola')
      return
    }

    const newTransaction = {
      ...form,
      date: new Date().toLocaleString(),
      id: crypto.randomUUID()
    }

    saveTransactions([...transactions, newTransaction])

    setForm({
      name: '',
      telegram: '',
      fromWallet: '',
      toWallet: '',
      fromAmount: '',
      fromCurrency: 'USDT',
      toAmount: '',
      toCurrency: 'PLN',
      fee: '',
      note: ''
    })
  }

  const totalTurnover = transactions.reduce(
    (sum, t) => sum + Number(t.toAmount || 0),
    0
  )

  const totalFee = transactions.reduce(
    (sum, t) => sum + Number(t.fee || 0),
    0
  )

  if (!authorized) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-black text-white">
        <div className="bg-zinc-900 p-8 rounded-xl w-full max-w-sm">
          <h1 className="text-xl mb-4">Dostęp do /admin</h1>
          <input
            type="password"
            placeholder="Hasło"
            className="w-full p-2 mb-4 bg-black border border-zinc-700"
            onChange={(e) => setPassword(e.target.value)}
          />
          <button
            onClick={handleLogin}
            className="w-full bg-green-600 p-2 rounded"
          >
            Wejdź
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-black text-white p-10">
      <h1 className="text-2xl mb-6">Panel administracyjny /admin</h1>

      <div className="grid grid-cols-2 gap-4 max-w-3xl">
        <input placeholder="Imię klienta" value={form.name} onChange={e => setForm({...form, name: e.target.value})} className="p-2 bg-zinc-900 border"/>
        <input placeholder="Telegram @user" value={form.telegram} onChange={e => setForm({...form, telegram: e.target.value})} className="p-2 bg-zinc-900 border"/>
        <input placeholder="Z portfela" value={form.fromWallet} onChange={e => setForm({...form, fromWallet: e.target.value})} className="p-2 bg-zinc-900 border"/>
        <input placeholder="Do portfela" value={form.toWallet} onChange={e => setForm({...form, toWallet: e.target.value})} className="p-2 bg-zinc-900 border"/>

        <input placeholder="Kwota wejściowa" value={form.fromAmount} onChange={e => setForm({...form, fromAmount: e.target.value})} className="p-2 bg-zinc-900 border"/>
        <select value={form.fromCurrency} onChange={e => setForm({...form, fromCurrency: e.target.value})} className="p-2 bg-zinc-900 border">
          <option>USDT</option>
          <option>PLN</option>
          <option>EUR</option>
          <option>USD</option>
        </select>

        <input placeholder="Kwota wyjściowa" value={form.toAmount} onChange={e => setForm({...form, toAmount: e.target.value})} className="p-2 bg-zinc-900 border"/>
        <select value={form.toCurrency} onChange={e => setForm({...form, toCurrency: e.target.value})} className="p-2 bg-zinc-900 border">
          <option>PLN</option>
          <option>EUR</option>
          <option>USD</option>
          <option>USDT</option>
        </select>

        <input placeholder="Prowizja / bonus" value={form.fee} onChange={e => setForm({...form, fee: e.target.value})} className="p-2 bg-zinc-900 border"/>
        <input placeholder="Uwaga" value={form.note} onChange={e => setForm({...form, note: e.target.value})} className="p-2 bg-zinc-900 border col-span-2"/>
      </div>

      <button
        onClick={addTransaction}
        className="mt-6 bg-green-600 px-6 py-2 rounded"
      >
        Zapisz transakcję
      </button>

      <h2 className="mt-10 mb-2 text-lg">Dziś: {today}</h2>
      <p>Ilość transakcji: {transactions.length}</p>
      <p>Obrót łącznie: {totalTurnover}</p>
      <p>Prowizje łącznie: {totalFee}</p>

      <div className="mt-6">
        {transactions.map(t => (
          <div key={t.id} className="border border-zinc-800 p-4 mb-2 rounded">
            <b>{t.name}</b> ({t.telegram}) <br/>
            {t.fromAmount} {t.fromCurrency} → {t.toAmount} {t.toCurrency}<br/>
            Prowizja: {t.fee}<br/>
            {t.fromWallet} → {t.toWallet}
            <br/>
            <small>{t.date}</small>
          </div>
        ))}
      </div>
    </div>
  )
}