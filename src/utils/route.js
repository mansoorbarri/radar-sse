// Downsample an array to at most maxLength elements, keeping first and last
function downsampleRoute(coords, maxLength) {
  if (coords.length <= maxLength) return coords;

  const result = [coords[0]];
  const step = (coords.length - 1) / (maxLength - 1);

  for (let i = 1; i < maxLength - 1; i++) {
    result.push(coords[Math.round(i * step)]);
  }

  result.push(coords[coords.length - 1]);
  return result;
}

module.exports = {
  downsampleRoute,
};
