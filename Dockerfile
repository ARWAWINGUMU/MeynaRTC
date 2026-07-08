FROM gradle:9.0-jdk17 AS build
WORKDIR /app
COPY . .
RUN gradle installDist --no-daemon

FROM eclipse-temurin:17-jre
WORKDIR /app
COPY --from=build /app/build/install/ ./
RUN chmod +x */bin/*
CMD sh -c "./*/bin/*"
