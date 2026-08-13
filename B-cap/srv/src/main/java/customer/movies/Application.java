package customer.movies;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

/**
 * B アプリ(movies) の Spring Boot 起動クラス。
 * A-cap とは別プロセス・別ポート(4005)・別DBで動く、完全に独立したバックエンド。
 */
@SpringBootApplication
public class Application {

	public static void main(String[] args) {
		SpringApplication.run(Application.class, args);
	}

}
