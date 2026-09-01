export default function OperationCard({ vessel, photoSrc }) {
  if (!vessel) {
    return (
      <article className="op-card is-empty">
        <p>No ranked vessel yet. Run hindcast to load AIS candidates from the backend.</p>
      </article>
    );
  }

  return (
    <article className="op-card">
      <img src={photoSrc} alt="" />
      <div className="op-card-body">
        <p className="op-kicker">{vessel.type || "Vessel"}</p>
        <h3>{vessel.name || vessel.mmsi}</h3>
        <p className="op-meta">MMSI {vessel.mmsi || vessel.id}</p>
        {Number.isFinite(Number(vessel.speedKnots)) && (
          <p className="op-meta">{Number(vessel.speedKnots).toFixed(1)} kn</p>
        )}
      </div>
    </article>
  );
}
