export function ProductChangeLogSection({ productName, reportDate }: { productName: string; reportDate: string }) {
  return (
    <section className="product-change-log">
      <h3>광고 수정 기록</h3>
      <p>{reportDate} {productName}에 등록된 기록이 없습니다.</p>
    </section>
  );
}
