"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";

export function TrendChart({ data }: { data: unknown[] }) {
  return (
    <div className="chart-box">
      <ResponsiveContainer>
        <LineChart data={data}>
          <CartesianGrid stroke="#e4e9ee" />
          <XAxis dataKey="date" />
          <YAxis />
          <Tooltip />
          <Legend />
          <Line type="monotone" dataKey="spendKrw" name="광고비" stroke="#2764b7" strokeWidth={2} dot={false} />
          <Line type="monotone" dataKey="purchaseCount" name="구매수" stroke="#137a45" strokeWidth={2} dot={false} />
          <Line type="monotone" dataKey="cpaKrw" name="CPA" stroke="#a15c00" strokeWidth={2} dot={false} />
          <Line type="monotone" dataKey="marginKrw" name="마진" stroke="#6f42a3" strokeWidth={2} dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export function ProductBarChart({ data }: { data: unknown[] }) {
  return (
    <div className="chart-box">
      <ResponsiveContainer>
        <BarChart data={data}>
          <CartesianGrid stroke="#e4e9ee" />
          <XAxis dataKey="name" />
          <YAxis />
          <Tooltip />
          <Legend />
          <Bar dataKey="spendKrw" name="광고비" fill="#2764b7" />
          <Bar dataKey="marginKrw" name="마진" fill="#137a45" />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function StageBarChart({ data }: { data: unknown[] }) {
  return (
    <div className="chart-box">
      <ResponsiveContainer>
        <BarChart data={data}>
          <CartesianGrid stroke="#e4e9ee" />
          <XAxis dataKey="group" />
          <YAxis />
          <Tooltip />
          <Legend />
          <Bar dataKey="spendKrw" name="광고비" fill="#146c63" />
          <Bar dataKey="purchaseCount" name="구매수" fill="#a15c00" />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
