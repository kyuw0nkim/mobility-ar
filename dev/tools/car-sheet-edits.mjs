// 차 도안 원본(sheet-src/차도안-원본.pdf)에서 바꾼 것 — edit-car-sheet.mjs(PDF 만들기)와 extract-car-templates.mjs(치수)가 함께 씀
export const TITLE = '나의 자율주행 자동차 디자인';
// 쪽 순서: PBV ①②, 로보택시 ①②, 배송 트럭 ①②
export const PAGE_SUBTITLES = ['① 겉모습', '② 앞·뒤와 실내', '① 겉모습', '② 앞·뒤와 실내', '① 겉모습', '② 앞·뒤와 짐칸'];
// '내 차 이름' 칸 (테두리 선 가운데 기준, mm). 원본은 x 30~180
export const NAME_BOX = { x0: 45, x1: 165, y0: 33.0, y1: 56.74 };
